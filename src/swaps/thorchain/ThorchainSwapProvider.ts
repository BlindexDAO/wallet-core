import { chains, currencyToUnit, isEthereumChain, unitToCurrency } from '@liquality/cryptoassets';
import { EthereumNetwork } from '@liquality/ethereum-networks';
import { Transaction } from '@liquality/types';
import {
  getDoubleSwapOutput,
  getDoubleSwapSlip,
  getSwapMemo,
  getValueOfAsset1InAsset2,
} from '@thorchain/asgardex-util';
import ERC20 from '@uniswap/v2-core/build/ERC20.json';
import { assetFromString, BaseAmount, baseAmount, baseToAsset } from '@xchainjs/xchain-util';
import axios from 'axios';
import BN, { BigNumber } from 'bignumber.js';
import * as ethers from 'ethers';
import { mapValues } from 'lodash';
import { v4 as uuidv4 } from 'uuid';
import buildConfig from '../../build.config';
import { ActionContext } from '../../store';
import { withInterval, withLock } from '../../store/actions/performNextAction/utils';
import { Asset, Network, SwapHistoryItem, WalletId } from '../../store/types';
import { isERC20 } from '../../utils/asset';
import { prettyBalance } from '../../utils/coinFormatter';
import cryptoassets from '../../utils/cryptoassets';
import { getTxFee } from '../../utils/fees';
import { ChainNetworks } from '../../utils/networks';
import { SwapProvider } from '../SwapProvider';
import {
  BaseSwapProviderConfig,
  EstimateFeeRequest,
  EstimateFeeResponse,
  NextSwapActionRequest,
  QuoteRequest,
  SwapQuote,
  SwapRequest,
  SwapStatus,
} from '../types';

// Pool balances are denominated with 8 decimals
const THORCHAIN_DECIMAL = 8;
const SAFE_FEE_MULTIPLIER = 1.3;
const MAX_FEE_SLIPPAGE_MULTIPLIER = 3;

const SUPPORTED_CHAINS = ['bitcoin', 'ethereum'];

const OUT_MEMO_TO_STATUS = {
  OUT: 'SUCCESS',
  REFUND: 'REFUNDED',
};

/**
 * Converts a `BaseAmount` string into `PoolData` balance (always `1e8` decimal based)
 */
const toPoolBalance = (baseAmountString: string) => baseAmount(baseAmountString, THORCHAIN_DECIMAL);

// TODO: this needs to go into cryptoassets. In fact, we should have large compatibility with the chain.asset notation
// Probably cryptoassets should adopt that kind of naming for assets
const toThorchainAsset = (asset: Asset) => {
  return isERC20(asset) ? `ETH.${asset}-${cryptoassets[asset].contractAddress!.toUpperCase()}` : `${asset}.${asset}`;
};

/**
 * Helper to convert decimal of asset amounts
 *
 * It can be used to convert Midgard/THORChain amounts,
 * which are always based on 1e8 decimal into any 1e(n) decimal
 *
 * Examples:
 * ETH.ETH: 1e8 -> 1e18
 * ETH.USDT: 1e8 -> 1e6
 *
 * @param amount BaseAmount to convert
 * @param decimal Target decimal
 */
const convertBaseAmountDecimal = (amount: BaseAmount, decimal: number) => {
  const decimalDiff = decimal - amount.decimal;

  const amountBN =
    decimalDiff < 0
      ? amount
          .amount()
          .dividedBy(new BN(10 ** (decimalDiff * -1)))
          // Never use `BigNumber`s with decimal within `BaseAmount`
          // that's why we need to set `decimalPlaces` to `0`
          // round down is needed to make sure amount of currency is still available
          // without that, `dividedBy` might round up and provide an currency amount which does not exist
          .decimalPlaces(0, BN.ROUND_DOWN)
      : amount.amount().multipliedBy(new BN(10 ** decimalDiff));
  return baseAmount(amountBN, decimal);
};

export interface ThorchainSwapProviderConfig extends BaseSwapProviderConfig {
  thornode: string;
}

export interface ThorchainPool {
  balance_rune: string;
  balance_asset: string;
  asset: string;
  LP_units: string;
  pool_units: string;
  status: string;
  synth_units: string;
  synth_supply: string;
  pending_inbound_rune: string;
  pending_inbound_asset: string;
}

export interface ThorchainInboundAddress {
  chain: string;
  pub_key: string;
  address: string;
  halted: boolean;
  gas_rate: string;
  router?: string;
}

export interface ThorchainTx {
  id: string;
  chain: string;
  from_address: string;
  to_address: string;
  coins: {
    asset: string;
    amount: string;
  }[];
  gas: {
    asset: string;
    amount: string;
  }[];
  memo: string;
}

export interface ThorchainObservedTx {
  tx: ThorchainTx;
  status: string;
  block_height: number;
  signers: string[];
  observed_pub_key: string;
  finalise_height: number;
  out_hashes: string[];
}

export interface ThorchainTransactionResponse {
  keysign_metric: {
    tx_id: string;
    node_tss_times?: any;
  };
  observed_tx: ThorchainObservedTx;
}

export enum ThorchainTxTypes {
  SWAP = 'SWAP',
}

export interface ThorchainSwapHistoryItem extends SwapHistoryItem {
  receiveFee: string;
  maxFeeSlippageMultiplier: number;
  approveTxHash: string;
  fromFundHash: string;
  approveTx: Transaction;
  fromFundTx: Transaction;
}

export interface ThorchainSwapQuote extends SwapQuote {
  receiveFee: string;
  slippage: number;
}

class ThorchainSwapProvider extends SwapProvider {
  config: ThorchainSwapProviderConfig;

  async getSupportedPairs() {
    return [];
  }

  async _getPools(): Promise<ThorchainPool[]> {
    return (await axios.get(`${this.config.thornode}/thorchain/pools`)).data;
  }

  async _getInboundAddresses(): Promise<ThorchainInboundAddress[]> {
    return (await axios.get(`${this.config.thornode}/thorchain/inbound_addresses`)).data;
  }

  async _getTransaction(hash: string): Promise<ThorchainTransactionResponse | null> {
    try {
      return (await axios.get(`${this.config.thornode}/thorchain/tx/${hash}`)).data;
    } catch (e) {
      // Error means tx not found
      return null;
    }
  }

  async getInboundAddress(chain: string) {
    const inboundAddresses = await this._getInboundAddresses();
    const inboundAddress = inboundAddresses.find((inbound) => inbound.chain === chain);
    if (!inboundAddress) throw new Error(`ThorchainSwapProvider: Inbound address for chain ${chain} not found`);
    return inboundAddress;
  }

  async getRouterAddress(chain: string) {
    const inboundAddress = await this.getInboundAddress(chain);
    const router = inboundAddress.router;
    if (!router) throw new Error(`ThorchainSwapProvider: Router address for chain ${chain} not found`);
    return router;
  }

  async getQuote({ from, to, amount }: QuoteRequest) {
    // Only ethereum, bitcoin and bc chains are supported
    if (!SUPPORTED_CHAINS.includes(cryptoassets[from].chain) || !SUPPORTED_CHAINS.includes(cryptoassets[to].chain))
      return null;

    const pools = await this._getPools();

    const fromPoolData = pools.find((pool) => pool.asset === toThorchainAsset(from));
    const toPoolData = pools.find((pool) => pool.asset === toThorchainAsset(to));

    if (!fromPoolData || !toPoolData) return null; // Pool doesn't exist
    if (fromPoolData.status.toLowerCase() !== 'available' || toPoolData.status.toLowerCase() !== 'available')
      return null; // Pool is not available

    const getPool = (poolData: ThorchainPool) => {
      return {
        assetBalance: toPoolBalance(poolData.balance_asset),
        runeBalance: toPoolBalance(poolData.balance_rune),
      };
    };

    const fromPool = getPool(fromPoolData);
    const toPool = getPool(toPoolData);

    const fromAmountInUnit = currencyToUnit(cryptoassets[from], new BN(amount));
    const baseInputAmount = baseAmount(fromAmountInUnit, cryptoassets[from].decimals);
    const inputAmount = convertBaseAmountDecimal(baseInputAmount, 8);

    // For RUNE it's `getSwapOutput`
    const swapOutput = getDoubleSwapOutput(inputAmount, fromPool, toPool);
    // TODO: test slippage
    const slippage = getDoubleSwapSlip(inputAmount, fromPool, toPool);

    const baseNetworkFee = await this.networkFees(to);
    if (!baseNetworkFee) throw new Error(`ThorchainSwapProvider: baseNetworkFee not found while getting quote.`);
    let networkFee = convertBaseAmountDecimal(baseNetworkFee, 8);

    if (isERC20(to)) {
      // in case of ERC20
      const poolData = pools.find((pool) => pool.asset === 'ETH.ETH');
      if (!poolData) {
        throw new Error(`ThorchainSwapProvider: pool data for ETH.ETH not found`);
      }
      const ethPool = toThorchainAsset(from) !== 'ETH.ETH' ? getPool(poolData) : fromPool;
      networkFee = getValueOfAsset1InAsset2(networkFee, ethPool, toPool);
    }

    const receiveFeeInUnit = currencyToUnit(cryptoassets[to], baseToAsset(networkFee).amount()).times(
      SAFE_FEE_MULTIPLIER
    );
    const toAmountInUnit = currencyToUnit(cryptoassets[to], baseToAsset(swapOutput).amount());
    return {
      from,
      to,
      fromAmount: fromAmountInUnit.toFixed(),
      toAmount: toAmountInUnit.toFixed(),
      receiveFee: receiveFeeInUnit.toFixed(),
      slippage: slippage.toNumber(),
      maxFeeSlippageMultiplier: MAX_FEE_SLIPPAGE_MULTIPLIER,
    };
  }

  async networkFees(asset: Asset) {
    const assetCode = isERC20(asset) ? chains[cryptoassets[asset].chain].nativeAsset : cryptoassets[asset].code;
    const gasRate = (await this.getInboundAddress(assetCode)).gas_rate;

    // https://github.com/thorchain/asgardex-electron/issues/1381
    if (isERC20(asset) && isEthereumChain(cryptoassets[asset].chain))
      return baseAmount(new BN(70000).times(gasRate).times(1000000000).times(3), 18);
    if (assetCode === 'ETH') return baseAmount(new BN(38000).times(gasRate).times(1000000000).times(3), 18);
    if (assetCode === 'BTC') return baseAmount(new BN(250).times(gasRate).times(3), 8);
  }

  async approveTokens({ network, walletId, swap }: NextSwapActionRequest<ThorchainSwapHistoryItem>) {
    const fromChain = cryptoassets[swap.from].chain;
    // @ts-ignore
    const chainNetwork = ChainNetworks[fromChain];
    const chainId = (chainNetwork[network] as EthereumNetwork).chainId;

    const api = new ethers.providers.InfuraProvider(chainId, buildConfig.infuraApiKey);
    const erc20 = new ethers.Contract(cryptoassets[swap.from].contractAddress!, ERC20.abi, api);

    const fromThorchainAsset = assetFromString(toThorchainAsset(swap.from));
    if (!fromThorchainAsset) {
      throw new Error('Thorchain asset does not exist');
    }
    const routerAddress = this.getRouterAddress(fromThorchainAsset.chain);

    const fromAddressRaw = await this.getSwapAddress(network, walletId, swap.from, swap.toAccountId);
    const fromAddress = chains[fromChain].formatAddress(fromAddressRaw, network);
    const allowance = await erc20.allowance(fromAddress, routerAddress);
    const inputAmount = ethers.BigNumber.from(new BN(swap.fromAmount).toFixed());
    if (allowance.gte(inputAmount)) {
      ``;
      return {
        status: 'APPROVE_CONFIRMED',
      };
    }

    const inputAmountHex = inputAmount.toHexString();
    const encodedData = erc20.interface.encodeFunctionData('approve', [routerAddress, inputAmountHex]);

    const client = this.getClient(network, walletId, swap.from, swap.fromAccountId);
    const approveTx = await client.chain.sendTransaction({
      to: cryptoassets[swap.from].contractAddress!,
      value: new BigNumber(0),
      data: encodedData,
      fee: swap.fee,
    });

    return {
      status: 'WAITING_FOR_APPROVE_CONFIRMATIONS',
      approveTx,
      approveTxHash: approveTx.hash,
    };
  }

  async sendBitcoinSwap({
    quote,
    network,
    walletId,
    memo,
  }: {
    quote: ThorchainSwapHistoryItem;
    network: Network;
    walletId: WalletId;
    memo: string;
  }) {
    await this.sendLedgerNotification(quote.fromAccountId, 'Signing required to complete the swap.');

    const fromThorchainAsset = assetFromString(toThorchainAsset(quote.from));
    if (!fromThorchainAsset) {
      throw new Error('Thorchain asset does not exist');
    }
    const to = (await this.getInboundAddress(fromThorchainAsset.chain)).address; // Will be `router` for ETH
    const value = new BN(quote.fromAmount);
    const encodedMemo = Buffer.from(memo, 'utf-8').toString('hex');

    const client = this.getClient(network, walletId, quote.from, quote.fromAccountId);
    const fromFundTx = await client.chain.sendTransaction({
      to: to,
      value,
      data: encodedMemo,
      fee: quote.fee,
    });
    return fromFundTx;
  }

  async sendEthereumSwap({
    quote,
    network,
    walletId,
    memo,
  }: {
    quote: ThorchainSwapHistoryItem;
    network: Network;
    walletId: WalletId;
    memo: string;
  }) {
    await this.sendLedgerNotification(quote.fromAccountId, 'Signing required to complete the swap.');

    const fromThorchainAsset = assetFromString(toThorchainAsset(quote.from));
    if (!fromThorchainAsset) {
      throw new Error('Thorchain asset does not exist');
    }
    const routerAddress = await this.getRouterAddress(fromThorchainAsset.chain);
    // @ts-ignore
    const chainNetwork = ChainNetworks[cryptoassets[quote.from].chain];
    const chainId = (chainNetwork[network] as EthereumNetwork).chainId;
    const api = new ethers.providers.InfuraProvider(chainId, buildConfig.infuraApiKey);
    const tokenAddress = isERC20(quote.from)
      ? cryptoassets[quote.from].contractAddress
      : '0x0000000000000000000000000000000000000000';
    const thorchainRouter = new ethers.Contract(
      routerAddress,
      ['function deposit(address payable vault, address asset, uint amount, string memory memo) external payable'],
      api
    );

    const amountHex = ethers.BigNumber.from(new BN(quote.fromAmount).toFixed()).toHexString();
    const to = (await this.getInboundAddress(fromThorchainAsset.chain)).address;
    const encodedData = thorchainRouter.interface.encodeFunctionData('deposit', [to, tokenAddress, amountHex, memo]);
    const value = isERC20(quote.from) ? new BigNumber(0) : new BN(quote.fromAmount);

    const client = this.getClient(network, walletId, quote.from, quote.fromAccountId);
    const fromFundTx = await client.chain.sendTransaction({
      to: routerAddress,
      value,
      data: encodedData,
      fee: quote.fee,
    });

    return fromFundTx;
  }

  async makeMemo({ network, walletId, swap }: NextSwapActionRequest<ThorchainSwapQuote>) {
    const toChain = cryptoassets[swap.to].chain;
    const toAddressRaw = await this.getSwapAddress(network, walletId, swap.to, swap.toAccountId);
    const toAddress = chains[toChain].formatAddress(toAddressRaw, network);
    // Substract swap.receiveFee from toAmount as this is the minimum limit that you are going to receive
    const baseOutputAmount = baseAmount(
      new BigNumber(swap.toAmount).minus(swap.receiveFee),
      cryptoassets[swap.to].decimals
    );
    const slippageCoefficient = new BN(1).minus(swap.slippage);
    const minimumOutput = baseOutputAmount.amount().multipliedBy(slippageCoefficient).dp(0);
    const limit = convertBaseAmountDecimal(baseAmount(minimumOutput, cryptoassets[swap.to].decimals), 8);
    const thorchainAsset = assetFromString(toThorchainAsset(swap.to));
    if (!thorchainAsset) {
      throw new Error('Thorchain asset does not exist');
    }
    return getSwapMemo({ asset: thorchainAsset, address: toAddress, limit });
  }

  async sendSwap({ network, walletId, swap }: NextSwapActionRequest<ThorchainSwapHistoryItem>) {
    const memo = await this.makeMemo({ network, walletId, swap });
    let fromFundTx;
    if (swap.from === 'BTC') {
      fromFundTx = await this.sendBitcoinSwap({
        quote: swap,
        network,
        walletId,
        memo,
      });
    } else if (swap.from === 'ETH' || isERC20(swap.from)) {
      fromFundTx = await this.sendEthereumSwap({
        quote: swap,
        network,
        walletId,
        memo,
      });
    }

    if (!fromFundTx) {
      throw new Error('ThorchainSwapProvider: Did not send swap transaction');
    }

    return {
      status: 'WAITING_FOR_SEND_CONFIRMATIONS',
      fromFundTx,
      fromFundHash: fromFundTx.hash,
    };
  }

  async newSwap({ network, walletId, quote }: SwapRequest<ThorchainSwapHistoryItem>) {
    const approvalRequired = isERC20(quote.from);
    const updates = approvalRequired
      ? await this.approveTokens({ network, walletId, swap: quote })
      : await this.sendSwap({ network, walletId, swap: quote });

    return {
      id: uuidv4(),
      fee: quote.fee,
      slippage: 50,
      ...updates,
    };
  }

  async estimateFees({
    network,
    walletId,
    asset,
    txType,
    quote,
    feePrices,
    max,
  }: EstimateFeeRequest<ThorchainTxTypes, ThorchainSwapQuote>) {
    if (txType === this._txTypes().SWAP && asset === 'BTC') {
      const client = this.getClient(network, walletId, asset, quote.fromAccountId);
      const value = max ? undefined : new BN(quote.fromAmount);
      const memo = await this.makeMemo({ network, walletId, swap: quote });
      const encodedMemo = Buffer.from(memo, 'utf-8').toString('hex');
      const txs = feePrices.map((fee) => ({
        to: '',
        value,
        data: encodedMemo,
        fee,
      }));
      const totalFees = await client.getMethod('getTotalFees')(txs, max);
      return mapValues(totalFees, (f) => unitToCurrency(cryptoassets[asset], f));
    }

    if (txType in this.feeUnits) {
      const fees: EstimateFeeResponse = {};
      for (const feePrice of feePrices) {
        fees[feePrice] = getTxFee(this.feeUnits[txType], asset, feePrice);
      }
      return fees;
    }

    return null;
  }

  async waitForApproveConfirmations({ swap, network, walletId }: NextSwapActionRequest<ThorchainSwapHistoryItem>) {
    const client = this.getClient(network, walletId, swap.from, swap.fromAccountId);

    try {
      const tx = await client.chain.getTransactionByHash(swap.approveTxHash);
      if (tx && tx.confirmations && tx.confirmations > 0) {
        return {
          endTime: Date.now(),
          status: 'APPROVE_CONFIRMED',
        };
      }
    } catch (e) {
      if (e.name === 'TxNotFoundError') console.warn(e);
      else throw e;
    }
  }

  async waitForSendConfirmations({ swap, network, walletId }: NextSwapActionRequest<ThorchainSwapHistoryItem>) {
    const client = this.getClient(network, walletId, swap.from, swap.fromAccountId);

    try {
      const tx = await client.chain.getTransactionByHash(swap.fromFundHash);
      if (tx && tx.confirmations && tx.confirmations > 0) {
        return {
          endTime: Date.now(),
          status: 'WAITING_FOR_RECEIVE',
        };
      }
    } catch (e) {
      if (e.name === 'TxNotFoundError') console.warn(e);
      else throw e;
    }
  }

  async waitForReceive({ swap, network, walletId }: NextSwapActionRequest<ThorchainSwapHistoryItem>) {
    try {
      const thorchainTx = await this._getTransaction(swap.fromFundHash);
      const receiveHash = thorchainTx?.observed_tx?.out_hashes?.[0];
      if (receiveHash) {
        const thorchainReceiveTx = await this._getTransaction(receiveHash);
        if (thorchainReceiveTx) {
          const memo = thorchainReceiveTx.observed_tx?.tx?.memo;
          const memoAction = memo.split(':')[0];

          let asset;
          let accountId;
          if (memoAction === 'OUT') {
            asset = swap.to;
            accountId = swap.toAccountId;
          } else if (memoAction === 'REFUND') {
            asset = swap.from;
            accountId = swap.fromAccountId;
          } else {
            throw new Error(`ThorchainSwapProvider: Unknown memo action ${memoAction}.`);
          }

          const client = this.getClient(network, walletId, asset, accountId);
          const receiveTx = await client.chain.getTransactionByHash(receiveHash);

          if (receiveTx && receiveTx.confirmations && receiveTx.confirmations > 0) {
            this.updateBalances(network, walletId, [asset]);
            const status = OUT_MEMO_TO_STATUS[memoAction];
            return {
              receiveTxHash: receiveTx.hash,
              receiveTx: receiveTx,
              endTime: Date.now(),
              status,
            };
          } else {
            return {
              receiveTxHash: receiveTx.hash,
              receiveTx: receiveTx,
            };
          }
        }
      }
    } catch (e) {
      if (e.name === 'TxNotFoundError') console.warn(e);
      else throw e;
    }
  }

  async performNextSwapAction(
    store: ActionContext,
    { network, walletId, swap }: NextSwapActionRequest<ThorchainSwapHistoryItem>
  ) {
    switch (swap.status) {
      case 'WAITING_FOR_APPROVE_CONFIRMATIONS':
        return withInterval(async () => this.waitForApproveConfirmations({ swap, network, walletId }));
      case 'APPROVE_CONFIRMED':
        return withLock(store, { item: swap, network, walletId, asset: swap.from }, async () =>
          this.sendSwap({ swap, network, walletId })
        );
      case 'WAITING_FOR_SEND_CONFIRMATIONS':
        return withInterval(async () => this.waitForSendConfirmations({ swap, network, walletId }));
      case 'WAITING_FOR_RECEIVE':
        return withInterval(async () => this.waitForReceive({ swap, network, walletId }));
    }
  }

  protected _txTypes() {
    return ThorchainTxTypes;
  }

  private feeUnits = {
    [ThorchainTxTypes.SWAP]: {
      ETH: 200000,
      BNB: 200000,
      MATIC: 200000,
      ERC20: 100000 + 200000, // (potential)ERC20 Approval + Swap
    },
  };

  protected _getStatuses(): Record<string, SwapStatus> {
    return {
      WAITING_FOR_APPROVE_CONFIRMATIONS: {
        step: 0,
        label: 'Approving {from}',
        filterStatus: 'PENDING',
        notification(swap: any) {
          return {
            message: `Approving ${swap.from}`,
          };
        },
      },
      APPROVE_CONFIRMED: {
        step: 1,
        label: 'Swapping {from}',
        filterStatus: 'PENDING',
      },
      WAITING_FOR_SEND_CONFIRMATIONS: {
        step: 1,
        label: 'Swapping {from}',
        filterStatus: 'PENDING',
        notification() {
          return {
            message: 'Swap initiated',
          };
        },
      },
      WAITING_FOR_RECEIVE: {
        step: 2,
        label: 'Swapping {from}',
        filterStatus: 'PENDING',
      },
      SUCCESS: {
        step: 3,
        label: 'Completed',
        filterStatus: 'COMPLETED',
        notification(swap: any) {
          return {
            message: `Swap completed, ${prettyBalance(swap.toAmount, swap.to)} ${swap.to} ready to use`,
          };
        },
      },
      REFUNDED: {
        step: 3,
        label: 'Refunded',
        filterStatus: 'REFUNDED',
        notification() {
          return {
            message: 'Swap refunded',
          };
        },
      },
    };
  }

  protected _fromTxType(): string | null {
    return this._txTypes().SWAP;
  }

  protected _toTxType(): string | null {
    return null;
  }

  protected _timelineDiagramSteps(): string[] {
    return ['APPROVE', 'INITIATION', 'RECEIVE'];
  }

  protected _totalSteps(): number {
    return 4;
  }
}

export { ThorchainSwapProvider };

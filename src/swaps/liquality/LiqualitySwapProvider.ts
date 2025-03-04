import { sha256 } from '@liquality/crypto';
import { chains, currencyToUnit, unitToCurrency } from '@liquality/cryptoassets';
import { Transaction } from '@liquality/types';
import axios from 'axios';
import BN, { BigNumber } from 'bignumber.js';
import { mapValues } from 'lodash';
import pkg from '../../../package.json';
import { ActionContext } from '../../store';
import { withInterval, withLock } from '../../store/actions/performNextAction/utils';
import { AccountId, Asset, Network, SwapHistoryItem, WalletId } from '../../store/types';
import { timestamp, wait } from '../../store/utils';
import { isERC20 } from '../../utils/asset';
import { prettyBalance } from '../../utils/coinFormatter';
import cryptoassets from '../../utils/cryptoassets';
import { getTxFee } from '../../utils/fees';
import { SwapProvider } from '../SwapProvider';
import {
  BaseSwapProviderConfig,
  EstimateFeeRequest,
  EstimateFeeResponse,
  NextSwapActionRequest,
  QuoteRequest,
  SwapRequest,
  SwapStatus,
} from '../types';

const VERSION_STRING = `Wallet ${pkg.version} (CAL ${pkg.dependencies['@liquality/client']
  .replace('^', '')
  .replace('~', '')})`;

const headers = {
  'x-requested-with': VERSION_STRING,
  'x-liquality-user-agent': VERSION_STRING,
};

export enum LiqualityTxTypes {
  SWAP_INITIATION = 'SWAP_INITIATION',
  SWAP_CLAIM = 'SWAP_CLAIM',
}

export interface LiqualityMarketData {
  from: string;
  to: string;
  status: string;
  updatedAt: Date;
  createdAt: Date;
  max: number;
  min: number;
  minConf: number;
  rate: number;
}

export interface LiqualitySwapHistoryItem extends SwapHistoryItem {
  orderId: string;
  fromAddress: string;
  toAddress: string;
  fromCounterPartyAddress: string;
  toCounterPartyAddress: string;
  secretHash: string;
  secret: string;
  expiresAt: number;
  swapExpiration: number;
  nodeSwapExpiration: number;
  fromFundHash: string;
  fromFundTx: Transaction;
  refundTx: Transaction;
  refundHash: string;
  toClaimTx: Transaction;
  toClaimHash: string;
  toFundHash: string;
}

export interface LiqualitySwapProviderConfig extends BaseSwapProviderConfig {
  agent: string;
}

export class LiqualitySwapProvider extends SwapProvider {
  config: LiqualitySwapProviderConfig;
  private async getMarketInfo(): Promise<LiqualityMarketData[]> {
    return (
      await axios({
        url: this.config.agent + '/api/swap/marketinfo',
        method: 'get',
        headers,
      })
    ).data;
  }

  public async getSupportedPairs() {
    const markets = await this.getMarketInfo();
    const pairs = markets
      .filter((market) => cryptoassets[market.from] && cryptoassets[market.to])
      .map((market) => ({
        from: market.from,
        to: market.to,
        min: new BN(unitToCurrency(cryptoassets[market.from], market.min)).toFixed(),
        max: new BN(unitToCurrency(cryptoassets[market.from], market.max)).toFixed(),
        rate: new BN(market.rate).toFixed(),
        provider: this.config.providerId,
      }));

    return pairs;
  }

  public async getQuote({ network, from, to, amount }: QuoteRequest) {
    const marketData = this.getMarketData(network);
    // Quotes are retrieved using market data because direct quotes take a long time for BTC swaps (agent takes long to generate new address)
    const market = marketData.find(
      (market) =>
        market.provider === this.config.providerId &&
        market.to === to &&
        market.from === from &&
        new BN(amount).gte(new BN(market.min)) &&
        new BN(amount).lte(new BN(market.max))
    );

    if (!market) return null;

    const fromAmount = currencyToUnit(cryptoassets[from], amount);
    const toAmount = currencyToUnit(cryptoassets[to], new BN(amount).times(new BN(market.rate)));

    return {
      from,
      to,
      fromAmount: fromAmount.toFixed(),
      toAmount: toAmount.toFixed(),
    };
  }

  public async newSwap({ network, walletId, quote: _quote }: SwapRequest<LiqualitySwapHistoryItem>) {
    const lockedQuote = await this._getQuote({
      from: _quote.from,
      to: _quote.to,
      amount: _quote.fromAmount,
    });

    if (new BN(lockedQuote.toAmount).lt(new BN(_quote.toAmount).times(0.995))) {
      throw new Error('The quote slippage is too high (> 0.5%). Try again.');
    }

    const quote = {
      ..._quote,
      ...lockedQuote,
    };
    if (await this.hasQuoteExpired(quote)) {
      throw new Error('The quote is expired.');
    }

    quote.fromAddress = await this.getSwapAddress(network, walletId, quote.from, quote.fromAccountId);
    quote.toAddress = await this.getSwapAddress(network, walletId, quote.to, quote.toAccountId);

    const fromClient = this.getClient(network, walletId, quote.from, quote.fromAccountId);

    const message = [
      'Creating a swap with following terms:',
      `Send: ${quote.fromAmount} (lowest denomination) ${quote.from}`,
      `Receive: ${quote.toAmount} (lowest denomination) ${quote.to}`,
      `My ${quote.from} Address: ${quote.fromAddress}`,
      `My ${quote.to} Address: ${quote.toAddress}`,
      `Counterparty ${quote.from} Address: ${quote.fromCounterPartyAddress}`,
      `Counterparty ${quote.to} Address: ${quote.toCounterPartyAddress}`,
      `Timestamp: ${quote.swapExpiration}`,
    ].join('\n');

    const messageHex = Buffer.from(message, 'utf8').toString('hex');
    const secret = await fromClient.swap.generateSecret(messageHex);
    const secretHash = sha256(secret);

    const fromFundTx = await fromClient.swap.initiateSwap(
      {
        value: new BN(quote.fromAmount),
        recipientAddress: quote.fromCounterPartyAddress,
        refundAddress: quote.fromAddress,
        secretHash: secretHash,
        expiration: quote.swapExpiration,
      },
      quote.fee
    );

    return {
      ...quote,
      status: 'INITIATED',
      secret,
      secretHash,
      fromFundHash: fromFundTx.hash,
      fromFundTx,
    };
  }

  public async estimateFees({
    network,
    walletId,
    asset,
    txType,
    quote,
    feePrices,
    max,
  }: EstimateFeeRequest<LiqualityTxTypes>) {
    if (txType === this._txTypes().SWAP_INITIATION && asset === 'BTC') {
      const client = this.getClient(network, walletId, asset, quote.fromAccountId);
      const value = max ? undefined : new BN(quote.fromAmount);
      const txs = feePrices.map((fee) => ({ to: '', value, fee }));
      const totalFees = await client.getMethod('getTotalFees')(txs, max);
      return mapValues(totalFees, (f) => unitToCurrency(cryptoassets[asset], f));
    }

    if (txType === this._txTypes().SWAP_INITIATION && asset === 'NEAR') {
      const fees: EstimateFeeResponse = {};
      // default storage fee recommended by NEAR dev team
      // It leaves 0.02$ dust in the wallet on max value
      const storageFee = new BN(0.00125);
      for (const feePrice of feePrices) {
        fees[feePrice] = getTxFee(this.feeUnits[txType], asset, feePrice).plus(storageFee);
      }
      return fees;
    }

    if (txType in this.feeUnits) {
      const fees: EstimateFeeResponse = {};
      for (const feePrice of feePrices) {
        fees[feePrice] = getTxFee(this.feeUnits[txType], asset, feePrice);
      }

      return fees;
    }

    const fees: EstimateFeeResponse = {};
    for (const feePrice of feePrices) {
      fees[feePrice] = new BigNumber(0);
    }

    return fees;
  }

  public async updateOrder(order: LiqualitySwapHistoryItem) {
    const res = await axios({
      url: this.config.agent + '/api/swap/order/' + order.orderId,
      method: 'post',
      data: {
        fromAddress: order.fromAddress,
        toAddress: order.toAddress,
        fromFundHash: order.fromFundHash,
        secretHash: order.secretHash,
      },
      headers,
    });
    return res.data;
  }

  public async waitForClaimConfirmations({ swap, network, walletId }: NextSwapActionRequest<LiqualitySwapHistoryItem>) {
    const toClient = this.getClient(network, walletId, swap.to, swap.toAccountId);

    try {
      const tx = await toClient.chain.getTransactionByHash(swap.toClaimHash);

      if (tx && tx.confirmations && tx.confirmations > 0) {
        this.updateBalances(network, walletId, [swap.to, swap.from]);

        return {
          endTime: Date.now(),
          status: 'SUCCESS',
        };
      }
    } catch (e) {
      if (e.name === 'TxNotFoundError') console.warn(e);
      else throw e;
    }

    // Expiration check should only happen if tx not found
    const expirationUpdates = await this.handleExpirations({
      swap,
      network,
      walletId,
    });
    if (expirationUpdates) {
      return expirationUpdates;
    }
  }

  public async performNextSwapAction(
    store: ActionContext,
    { network, walletId, swap }: NextSwapActionRequest<LiqualitySwapHistoryItem>
  ) {
    switch (swap.status) {
      case 'INITIATED':
        return this.reportInitiation(swap);

      case 'INITIATION_REPORTED':
        return withInterval(async () => this.confirmInitiation({ swap, network, walletId }));

      case 'INITIATION_CONFIRMED':
        return withLock(store, { item: swap, network, walletId, asset: swap.from }, async () =>
          this.fundSwap({ swap, network, walletId })
        );

      case 'FUNDED':
        return withInterval(async () => this.findCounterPartyInitiation({ swap, network, walletId }));

      case 'CONFIRM_COUNTER_PARTY_INITIATION':
        return withInterval(async () => this.confirmCounterPartyInitiation({ swap, network, walletId }));

      case 'READY_TO_CLAIM':
        return withLock(store, { item: swap, network, walletId, asset: swap.to }, async () =>
          this.claimSwap({ swap, network, walletId })
        );

      case 'WAITING_FOR_CLAIM_CONFIRMATIONS':
        return withInterval(async () => this.waitForClaimConfirmations({ swap, network, walletId }));

      case 'WAITING_FOR_REFUND':
        return withInterval(async () => this.waitForRefund({ swap, network, walletId }));

      case 'GET_REFUND':
        return withLock(store, { item: swap, network, walletId, asset: swap.from }, async () =>
          this.refundSwap({ swap, network, walletId })
        );

      case 'WAITING_FOR_REFUND_CONFIRMATIONS':
        return withInterval(async () => this.waitForRefundConfirmations({ swap, network, walletId }));
    }
  }

  protected _txTypes() {
    return LiqualityTxTypes;
  }

  protected _getStatuses(): Record<string, SwapStatus> {
    return {
      INITIATED: {
        step: 0,
        label: 'Locking {from}',
        filterStatus: 'PENDING',
      },
      INITIATION_REPORTED: {
        step: 0,
        label: 'Locking {from}',
        filterStatus: 'PENDING',
        notification() {
          return {
            message: 'Swap initiated',
          };
        },
      },
      INITIATION_CONFIRMED: {
        step: 0,
        label: 'Locking {from}',
        filterStatus: 'PENDING',
      },

      FUNDED: {
        step: 1,
        label: 'Locking {to}',
        filterStatus: 'PENDING',
      },
      CONFIRM_COUNTER_PARTY_INITIATION: {
        step: 1,
        label: 'Locking {to}',
        filterStatus: 'PENDING',
        notification(swap: any) {
          return {
            message: `Counterparty sent ${prettyBalance(swap.toAmount, swap.to)} ${swap.to} to escrow`,
          };
        },
      },

      READY_TO_CLAIM: {
        step: 2,
        label: 'Claiming {to}',
        filterStatus: 'PENDING',
        notification() {
          return {
            message: 'Claiming funds',
          };
        },
      },
      WAITING_FOR_CLAIM_CONFIRMATIONS: {
        step: 2,
        label: 'Claiming {to}',
        filterStatus: 'PENDING',
      },
      WAITING_FOR_REFUND: {
        step: 2,
        label: 'Pending Refund',
        filterStatus: 'PENDING',
      },
      GET_REFUND: {
        step: 2,
        label: 'Refunding {from}',
        filterStatus: 'PENDING',
      },
      WAITING_FOR_REFUND_CONFIRMATIONS: {
        step: 2,
        label: 'Refunding {from}',
        filterStatus: 'PENDING',
      },

      REFUNDED: {
        step: 3,
        label: 'Refunded',
        filterStatus: 'REFUNDED',
        notification(swap: any) {
          return {
            message: `Swap refunded, ${prettyBalance(swap.fromAmount, swap.from)} ${swap.from} returned`,
          };
        },
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
      QUOTE_EXPIRED: {
        step: 3,
        label: 'Quote Expired',
        filterStatus: 'REFUNDED',
      },
    };
  }

  protected _fromTxType(): LiqualityTxTypes | null {
    return this._txTypes().SWAP_INITIATION;
  }

  protected _toTxType(): LiqualityTxTypes | null {
    return this._txTypes().SWAP_CLAIM;
  }

  protected _timelineDiagramSteps(): string[] {
    return ['INITIATION', 'AGENT_INITIATION', 'CLAIM_OR_REFUND'];
  }

  protected _totalSteps(): number {
    return 4;
  }

  private async _getQuote({ from, to, amount }: { from: Asset; to: Asset; amount: string }) {
    try {
      return (
        await axios({
          url: this.config.agent + '/api/swap/order',
          method: 'post',
          data: { from, to, fromAmount: amount },
          headers,
        })
      ).data;
    } catch (e) {
      if (e?.response?.data?.error) {
        throw new Error(e.response.data.error);
      } else {
        throw e;
      }
    }
  }

  private async waitForRefund({ swap, network, walletId }: NextSwapActionRequest<LiqualitySwapHistoryItem>) {
    if (await this.canRefund({ swap, network, walletId })) {
      return { status: 'GET_REFUND' };
    }
  }

  private async waitForRefundConfirmations({
    swap,
    network,
    walletId,
  }: NextSwapActionRequest<LiqualitySwapHistoryItem>) {
    const fromClient = this.getClient(network, walletId, swap.from, swap.fromAccountId);
    try {
      const tx = await fromClient.chain.getTransactionByHash(swap.refundHash);

      if (tx && tx.confirmations && tx.confirmations > 0) {
        return {
          endTime: Date.now(),
          status: 'REFUNDED',
        };
      }
    } catch (e) {
      if (e.name === 'TxNotFoundError') console.warn(e);
      else throw e;
    }
  }

  private async refundSwap({ swap, network, walletId }: NextSwapActionRequest<LiqualitySwapHistoryItem>) {
    const fromClient = this.getClient(network, walletId, swap.from, swap.fromAccountId);
    await this.sendLedgerNotification(swap.fromAccountId, 'Signing required to refund the swap.');
    const refundTx = await fromClient.swap.refundSwap(
      {
        value: new BN(swap.fromAmount),
        recipientAddress: swap.fromCounterPartyAddress,
        refundAddress: swap.fromAddress,
        secretHash: swap.secretHash,
        expiration: swap.swapExpiration,
      },
      swap.fromFundHash,
      swap.fee
    );

    return {
      refundHash: refundTx.hash,
      refundTx,
      status: 'WAITING_FOR_REFUND_CONFIRMATIONS',
    };
  }

  private async fundSwap({ swap, network, walletId }: NextSwapActionRequest<LiqualitySwapHistoryItem>) {
    if (await this.hasQuoteExpired(swap)) {
      return { status: 'QUOTE_EXPIRED' };
    }

    if (!isERC20(swap.from)) return { status: 'FUNDED' }; // Skip. Only ERC20 swaps need funding

    const fromClient = this.getClient(network, walletId, swap.from, swap.fromAccountId);

    await this.sendLedgerNotification(swap.fromAccountId, 'Signing required to fund the swap.');

    const fundTx = await fromClient.swap.fundSwap(
      {
        value: new BN(swap.fromAmount),
        recipientAddress: swap.fromCounterPartyAddress,
        refundAddress: swap.fromAddress,
        secretHash: swap.secretHash,
        expiration: swap.swapExpiration,
      },
      swap.fromFundHash,
      swap.fee
    );

    if (!fundTx) {
      throw new Error('Funding transaction returned null');
    }

    return {
      fundTxHash: fundTx.hash,
      status: 'FUNDED',
    };
  }

  private async reportInitiation(swap: LiqualitySwapHistoryItem) {
    if (await this.hasQuoteExpired(swap)) {
      return { status: 'WAITING_FOR_REFUND' };
    }

    await this.updateOrder(swap);

    return {
      status: 'INITIATION_REPORTED',
    };
  }

  private async confirmInitiation({ swap, network, walletId }: NextSwapActionRequest<LiqualitySwapHistoryItem>) {
    // Jump the step if counter party has already accepted the initiation
    const counterPartyInitiation = await this.findCounterPartyInitiation({
      swap,
      network,
      walletId,
    });
    if (counterPartyInitiation) return counterPartyInitiation;

    const fromClient = this.getClient(network, walletId, swap.from, swap.fromAccountId);

    try {
      const tx = await fromClient.chain.getTransactionByHash(swap.fromFundHash);

      if (tx && tx.confirmations && tx.confirmations > 0) {
        return {
          status: 'INITIATION_CONFIRMED',
        };
      }
    } catch (e) {
      if (e.name === 'TxNotFoundError') console.warn(e);
      else throw e;
    }
  }

  private async findCounterPartyInitiation({
    swap,
    network,
    walletId,
  }: NextSwapActionRequest<LiqualitySwapHistoryItem>) {
    const toClient = this.getClient(network, walletId, swap.to, swap.toAccountId);

    try {
      const tx = await toClient.swap.findInitiateSwapTransaction({
        value: new BN(swap.toAmount),
        recipientAddress: swap.toAddress,
        refundAddress: swap.toCounterPartyAddress,
        secretHash: swap.secretHash,
        expiration: swap.nodeSwapExpiration,
      });

      if (tx) {
        const toFundHash = tx.hash;

        const isVerified = await toClient.swap.verifyInitiateSwapTransaction(
          {
            value: new BN(swap.toAmount),
            recipientAddress: swap.toAddress,
            refundAddress: swap.toCounterPartyAddress,
            secretHash: swap.secretHash,
            expiration: swap.nodeSwapExpiration,
          },
          toFundHash
        );

        // ERC20 swaps have separate funding tx. Ensures funding tx has enough confirmations
        const fundingTransaction = await toClient.swap.findFundSwapTransaction(
          {
            value: new BN(swap.toAmount),
            recipientAddress: swap.toAddress,
            refundAddress: swap.toCounterPartyAddress,
            secretHash: swap.secretHash,
            expiration: swap.nodeSwapExpiration,
          },
          toFundHash
        );
        const fundingConfirmed = fundingTransaction
          ? fundingTransaction.confirmations &&
            fundingTransaction.confirmations >= chains[cryptoassets[swap.to].chain].safeConfirmations
          : true;

        if (isVerified && fundingConfirmed) {
          return {
            toFundHash,
            status: 'CONFIRM_COUNTER_PARTY_INITIATION',
          };
        }
      }
    } catch (e) {
      if (['BlockNotFoundError', 'PendingTxError', 'TxNotFoundError'].includes(e.name)) console.warn(e);
      else throw e;
    }

    // Expiration check should only happen if tx not found
    const expirationUpdates = await this.handleExpirations({
      swap,
      network,
      walletId,
    });

    if (expirationUpdates) {
      return expirationUpdates;
    }
  }

  private async confirmCounterPartyInitiation({
    swap,
    network,
    walletId,
  }: NextSwapActionRequest<LiqualitySwapHistoryItem>) {
    const toClient = this.getClient(network, walletId, swap.to, swap.toAccountId);

    const tx = await toClient.chain.getTransactionByHash(swap.toFundHash);

    if (tx && tx.confirmations && tx.confirmations >= chains[cryptoassets[swap.to].chain].safeConfirmations) {
      return {
        status: 'READY_TO_CLAIM',
      };
    }

    // Expiration check should only happen if tx not found
    const expirationUpdates = await this.handleExpirations({
      swap,
      network,
      walletId,
    });
    if (expirationUpdates) {
      return expirationUpdates;
    }
  }

  private async claimSwap({ swap, network, walletId }: NextSwapActionRequest<LiqualitySwapHistoryItem>) {
    const expirationUpdates = await this.handleExpirations({
      swap,
      network,
      walletId,
    });
    if (expirationUpdates) {
      return expirationUpdates;
    }

    const toClient = this.getClient(network, walletId, swap.to, swap.toAccountId);

    await this.sendLedgerNotification(swap.toAccountId, 'Signing required to claim the swap.');

    const toClaimTx = await toClient.swap.claimSwap(
      {
        value: new BN(swap.toAmount),
        recipientAddress: swap.toAddress,
        refundAddress: swap.toCounterPartyAddress,
        secretHash: swap.secretHash,
        expiration: swap.nodeSwapExpiration,
      },
      swap.toFundHash,
      swap.secret,
      swap.claimFee
    );

    return {
      toClaimHash: toClaimTx.hash,
      toClaimTx,
      status: 'WAITING_FOR_CLAIM_CONFIRMATIONS',
    };
  }

  private async hasQuoteExpired(swap: LiqualitySwapHistoryItem) {
    return timestamp() >= swap.expiresAt;
  }

  private async hasChainTimePassed({
    network,
    walletId,
    asset,
    timestamp,
    accountId,
  }: {
    network: Network;
    walletId: WalletId;
    asset: Asset;
    timestamp: number;
    accountId: AccountId;
  }) {
    const client = this.getClient(network, walletId, asset, accountId);
    const maxTries = 3;
    let tries = 0;
    while (tries < maxTries) {
      try {
        const blockNumber = await client.chain.getBlockHeight();
        const latestBlock = await client.chain.getBlockByNumber(blockNumber);
        return latestBlock.timestamp > timestamp;
      } catch (e) {
        tries++;
        if (tries >= maxTries) throw e;
        else {
          console.warn(e);
          await wait(2000);
        }
      }
    }
  }

  private async canRefund({ network, walletId, swap }: NextSwapActionRequest<LiqualitySwapHistoryItem>) {
    return this.hasChainTimePassed({
      network,
      walletId,
      asset: swap.from,
      timestamp: swap.swapExpiration,
      accountId: swap.fromAccountId,
    });
  }

  private async hasSwapExpired({ network, walletId, swap }: NextSwapActionRequest<LiqualitySwapHistoryItem>) {
    return this.hasChainTimePassed({
      network,
      walletId,
      asset: swap.to,
      timestamp: swap.nodeSwapExpiration,
      accountId: swap.toAccountId,
    });
  }

  private async handleExpirations({ network, walletId, swap }: NextSwapActionRequest<LiqualitySwapHistoryItem>) {
    if (await this.canRefund({ swap, network, walletId })) {
      return { status: 'GET_REFUND' };
    }
    if (await this.hasSwapExpired({ swap, network, walletId })) {
      return { status: 'WAITING_FOR_REFUND' };
    }
  }

  private feeUnits = {
    [LiqualityTxTypes.SWAP_INITIATION]: {
      ETH: 165000,
      RBTC: 165000,
      BNB: 165000,
      NEAR: 10000000000000,
      SOL: 2,
      LUNA: 800000,
      UST: 800000,
      MATIC: 165000,
      ERC20: 600000 + 94500, // Contract creation + erc20 transfer
      ARBETH: 2400000,
      AVAX: 165000,
    },
    [LiqualityTxTypes.SWAP_CLAIM]: {
      BTC: 143,
      ETH: 45000,
      RBTC: 45000,
      BNB: 45000,
      MATIC: 45000,
      NEAR: 8000000000000,
      SOL: 1,
      LUNA: 800000,
      UST: 800000,
      ERC20: 100000,
      ARBETH: 680000,
      AVAX: 45000,
    },
  };
}

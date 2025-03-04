import { ChainId } from '@liquality/cryptoassets';
import Bluebird from 'bluebird';
import { ActionContext, rootActionContext } from '..';
import { isEthereumChain } from '../../utils/asset';
import { AccountId, Asset, Network, WalletId } from '../types';

export const getUnusedAddresses = async (
  context: ActionContext,
  {
    network,
    walletId,
    assets,
    accountId,
  }: { network: Network; walletId: WalletId; assets: Asset[]; accountId: AccountId }
): Promise<string[]> => {
  const { state, commit, getters } = rootActionContext(context);
  return Bluebird.map(
    assets,
    async (asset) => {
      const accounts = state.accounts[walletId]?.[network];
      if (!accounts) {
        throw new Error('getUnusedAddresses: Accounts not found ');
      }
      const index = accounts.findIndex((a) => a.id === accountId);
      if (index >= 0 && asset) {
        const account = accounts[index];
        const result = await getters
          .client({
            network,
            walletId,
            asset,
            accountId: account.id,
          })
          .wallet.getUnusedAddress();

        const address = isEthereumChain(asset) ? result.address.replace('0x', '') : result.address; // TODO: Should not require removing 0x
        let updatedAddresses: string[] = [];
        if (account.chain === ChainId.Bitcoin) {
          if (!account.addresses.includes(address)) {
            updatedAddresses = [...account.addresses, address];
          } else {
            updatedAddresses = [...account.addresses];
          }
        } else {
          updatedAddresses = [address];
        }

        commit.UPDATE_ACCOUNT_ADDRESSES({
          network,
          accountId: account.id,
          walletId,
          addresses: updatedAddresses,
        });

        return address;
      }
      return '';
    },
    { concurrency: 1 }
  );
};

import { bitcoin } from '@liquality/types';

export function shortenAddress(address: string) {
  const prefix = address.startsWith('0x') ? '0x' : '';
  const isTerra = address.startsWith('terra');
  return `${prefix}${address.replace('0x', '').substring(0, prefix ? 4 : 6)}...${address.substring(
    isTerra ? address.length - 6 : address.length - 4
  )}`;
}

export const BitcoinAddressType = bitcoin.AddressType;

export const BTC_ADDRESS_TYPE_TO_PREFIX = {
  [BitcoinAddressType.LEGACY]: 44,
  [BitcoinAddressType.P2SH_SEGWIT]: 49,
  [BitcoinAddressType.BECH32]: 84,
};

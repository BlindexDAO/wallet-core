import buildConfig from '../build.config';
import { Network, SwapProviderType } from '../store/types';
import astroportInfo from '../swaps/astroport/info.json';
import fastbtcInfo from '../swaps/fastbtc/info.json';
import liqualityInfo from '../swaps/liquality/info.json';
import liqualityBoostERC20toNativeInfo from '../swaps/liqualityboost/liqualityBoostERC20toNative/info.json';
import liqualityBoostNativeToERC20Info from '../swaps/liqualityboost/liqualityBoostNativeToERC20/info.json';
import oneinchInfo from '../swaps/oneinch/info.json';
import sovrynInfo from '../swaps/sovryn/info.json';
import thorchainInfo from '../swaps/thorchain/info.json';
import uniswapInfo from '../swaps/uniswap/info.json';

const swapProviderInfo = {
  [SwapProviderType.Liquality]: liqualityInfo,
  [SwapProviderType.UniswapV2]: uniswapInfo,
  [SwapProviderType.OneInch]: oneinchInfo,
  [SwapProviderType.Thorchain]: thorchainInfo,
  [SwapProviderType.FastBTC]: fastbtcInfo,
  [SwapProviderType.LiqualityBoostNativeToERC20]: liqualityBoostNativeToERC20Info,
  [SwapProviderType.LiqualityBoostERC20ToNative]: liqualityBoostERC20toNativeInfo,
  [SwapProviderType.Sovryn]: sovrynInfo,
  [SwapProviderType.Astroport]: astroportInfo,
};

function getSwapProviderConfig(network: Network, providerId: string) {
  return buildConfig.swapProviders[network][providerId];
}

function getSwapProviderInfo(network: Network, providerId: string) {
  const config = getSwapProviderConfig(network, providerId);
  return swapProviderInfo[config.type];
}

export { getSwapProviderConfig, getSwapProviderInfo };

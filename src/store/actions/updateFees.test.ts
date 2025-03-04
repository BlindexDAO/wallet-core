import { setupWallet } from '../../index';
import defaultWalletOptions from '../../walletOptions/defaultOptions';

describe('updateFees tests', () => {
  jest.setTimeout(90000);
  const wallet = setupWallet(defaultWalletOptions);
  beforeEach(async () => {
    jest.useFakeTimers();
    await wallet.dispatch.createWallet({
      key: '0x1234567890123456789012345678901234567890',
      mnemonic: 'rough symbol license spirit advance pact catalog vibrant dream great usage empty',
      imported: true,
    });
    await wallet.dispatch.unlockWallet({
      key: '0x1234567890123456789012345678901234567890',
    });
  });

  it('should be able to update mainnet assets fees', async () => {
    expect(wallet.state.wallets.length).toBe(1);

    const walletId = wallet.state.activeWalletId;
    const mainnetEnabledAssets = wallet?.state?.enabledAssets?.mainnet?.[walletId];
    expect(mainnetEnabledAssets).not.toBeNull();
    expect(mainnetEnabledAssets?.length).toBeGreaterThan(10);
    // mainnet asset fee update
    for (const mainnnetAsset of mainnetEnabledAssets!) {
      await wallet.dispatch.updateFees({
        asset: mainnnetAsset,
      });
    }
    const maintainElement = wallet.state.fees.mainnet?.[walletId];
    // BTC fee object checks
    expect(maintainElement?.BTC).toHaveProperty('slow');
    expect(maintainElement?.BTC.slow.fee).not.toBe(0);
    expect(maintainElement?.BTC.slow.wait).toBe(3600);
    expect(maintainElement?.BTC).toHaveProperty('average');
    expect(maintainElement?.BTC.average.fee).not.toBe(0);
    expect(maintainElement?.BTC.average.wait).toBe(1800);
    expect(maintainElement?.BTC).toHaveProperty('fast');
    expect(maintainElement?.BTC.fast.fee).not.toBe(0);
    expect(maintainElement?.BTC.fast.wait).toBe(600);
    // LUNA fee object checks
    expect(maintainElement?.LUNA).toHaveProperty('slow');
    expect(maintainElement?.LUNA).toHaveProperty('average');
    expect(maintainElement?.LUNA).toHaveProperty('fast');
    expect(maintainElement?.LUNA.slow.fee).not.toBe(0);
    expect(maintainElement?.LUNA.average.fee).not.toBe(0);
    expect(maintainElement?.LUNA.fast.fee).not.toBe(0);
  });
  it('should be able to update testnet assets fees', async () => {
    expect(wallet.state.wallets.length).toBe(1);

    const walletId = wallet.state.activeWalletId;
    const testnetEnabledAssets = wallet?.state?.enabledAssets?.mainnet?.[walletId];
    expect(testnetEnabledAssets).not.toBeNull();
    expect(testnetEnabledAssets?.length).toBeGreaterThan(10);
    if (typeof testnetEnabledAssets !== 'undefined') {
      for (const testnetAsset of testnetEnabledAssets) {
        await wallet.dispatch.updateFees({
          asset: testnetAsset,
        });
      }
    }
    const testnetFeeElement = wallet.state.fees.mainnet?.[walletId];
    // BTC fee object checks
    expect(testnetFeeElement?.BTC).toHaveProperty('slow');
    expect(testnetFeeElement?.BTC.slow.fee).not.toBe(0);
    expect(testnetFeeElement?.BTC.slow.wait).toBe(3600);
    expect(testnetFeeElement?.BTC).toHaveProperty('average');
    expect(testnetFeeElement?.BTC.average.fee).not.toBe(0);
    expect(testnetFeeElement?.BTC.average.wait).toBe(1800);
    expect(testnetFeeElement?.BTC).toHaveProperty('fast');
    expect(testnetFeeElement?.BTC.fast.fee).not.toBe(0);
    expect(testnetFeeElement?.BTC.fast.wait).toBe(600);
    // LUNA fee object checks
    expect(testnetFeeElement?.LUNA).toHaveProperty('slow');
    expect(testnetFeeElement?.LUNA).toHaveProperty('average');
    expect(testnetFeeElement?.LUNA).toHaveProperty('fast');
    expect(testnetFeeElement?.LUNA.slow.fee).not.toBe(0);
    expect(testnetFeeElement?.LUNA.average.fee).not.toBe(0);
    expect(testnetFeeElement?.LUNA.fast.fee).not.toBe(0);
  });
});

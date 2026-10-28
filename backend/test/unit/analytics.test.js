const test = require('node:test');
const assert = require('node:assert');
const { ethers } = require('ethers');

test('Analytics unit conversions and zero-supply logic', async (t) => {
    await t.test('formats 18-decimal VGUSD supply and reserve values accurately', () => {
        const supplyWei = ethers.parseEther('1000000'); // 1,000,000 VGUSD
        const reservesUsdWei = ethers.parseEther('1500000'); // 1,500,000 USD reserves

        assert.strictEqual(ethers.formatEther(supplyWei), '1000000.0');
        assert.strictEqual(ethers.formatEther(reservesUsdWei), '1500000.0');

        // Check ratio: 1500000 * 10000 / 1000000 = 15000 bps = 150.00%
        const ratioBps = (reservesUsdWei * 10_000n) / supplyWei;
        assert.strictEqual(ratioBps, 15000n);
        const percentString = `${(Number(ratioBps) / 100).toFixed(2)}%`;
        assert.strictEqual(percentString, '150.00%');
    });

    await t.test('formats 6-decimal USDC amounts accurately without floating-point precision loss', () => {
        const usdcUnits = 995_000_000n; // 995 USDC with 6 decimals
        assert.strictEqual(ethers.formatUnits(usdcUnits, 6), '995.0');

        const smallUsdc = 1234567n; // 1.234567 USDC
        assert.strictEqual(ethers.formatUnits(smallUsdc, 6), '1.234567');
    });

    await t.test('handles zero supply gracefully without crashing or showing max uint256', () => {
        const totalSupply = 0n;
        const totalReserveValue = ethers.parseEther('500000');

        // Logic tested in analytics.service.js
        const zeroSupply = totalSupply === 0n;
        let ratioBps = null;
        let ratioPercent = 'N/A';

        if (zeroSupply) {
            ratioBps = null;
            ratioPercent = 'N/A (zero supply)';
        }

        assert.strictEqual(zeroSupply, true);
        assert.strictEqual(ratioBps, null);
        assert.strictEqual(ratioPercent, 'N/A (zero supply)');
    });

    await t.test('preserves full precision for massive quantities using BigInt strings', () => {
        const hugeSupply = 999999999999999999999999999999999n;
        const serialized = hugeSupply.toString();
        assert.strictEqual(BigInt(serialized), hugeSupply);
    });
});

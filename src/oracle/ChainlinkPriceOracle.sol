// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @title ChainlinkPriceOracle
/// @notice Wraps a Chainlink-style feed with staleness checks and a DAO-set, time-boxed fallback price.
/// @dev Prices are normalised to 18 decimals. The fallback is used only while the feed is invalid or stale.
contract ChainlinkPriceOracle is IPriceOracle, AccessControl {
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    AggregatorV3Interface public feed;
    uint256 public maxStaleness;

    uint256 public fallbackPrice;
    uint256 public fallbackValidUntil;

    event FeedUpdated(address indexed feed, uint256 maxStaleness);
    event FallbackPriceSet(uint256 price, uint256 validUntil);

    error ZeroAddress();
    error NoValidPrice();

    constructor(AggregatorV3Interface feed_, uint256 maxStaleness_, address admin) {
        if (address(feed_) == address(0) || admin == address(0)) revert ZeroAddress();
        feed = feed_;
        maxStaleness = maxStaleness_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
        emit FeedUpdated(address(feed_), maxStaleness_);
    }

    /// @inheritdoc IPriceOracle
    function price() external view returns (uint256) {
        (bool ok, uint256 p) = feedPrice();
        if (ok) return p;
        if (fallbackPrice != 0 && block.timestamp <= fallbackValidUntil) return fallbackPrice;
        revert NoValidPrice();
    }

    /// @notice Latest feed price in 18 decimals and whether it is fresh and positive.
    function feedPrice() public view returns (bool ok, uint256 p) {
        try feed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > maxStaleness) {
                return (false, 0);
            }
            uint8 dec = feed.decimals();
            p = dec <= 18 ? uint256(answer) * 10 ** (18 - dec) : uint256(answer) / 10 ** (dec - 18);
            return (true, p);
        } catch {
            return (false, 0);
        }
    }

    function setFeed(AggregatorV3Interface newFeed, uint256 newMaxStaleness) external onlyRole(GOVERNOR_ROLE) {
        if (address(newFeed) == address(0)) revert ZeroAddress();
        feed = newFeed;
        maxStaleness = newMaxStaleness;
        emit FeedUpdated(address(newFeed), newMaxStaleness);
    }

    /// @notice Sets a fallback price (18 decimals) used until `validUntil` if the feed is unavailable.
    function setFallbackPrice(uint256 newPrice, uint256 validUntil) external onlyRole(GOVERNOR_ROLE) {
        fallbackPrice = newPrice;
        fallbackValidUntil = validUntil;
        emit FallbackPriceSet(newPrice, validUntil);
    }
}

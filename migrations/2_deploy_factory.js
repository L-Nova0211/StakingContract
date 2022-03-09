const StakingRewardsFactory = artifacts.require("StakingRewardsFactory");
const UniswapV2Factory = artifacts.require("IUniswapV2Factory")
const UniswaV2FactoryJSON = require('../build/IUniswapV2Factory')
const { ethers, BigNumber } = require("ethers"); 

let SKYLFI = "0x398dD6876a780cc016108ce674B3A7A5d226d62c";

function expandTo18Decimals(n) {
    return BigNumber.from(n).mul(BigNumber.from(10).pow(18))
  }
  
function expandTo17Decimals(n) {
    return BigNumber.from(n).mul(BigNumber.from(10).pow(17))
}

module.exports = function (deployer) {
  const now = new Date();  
  const secondsSinceEpoch = Math.round(now.getTime() / 1000)

  const nonWithdrawalBoost = expandTo17Decimals(5);
  const nonWithdrawalBoostPeriod = 356;
  const minimumLockDays = 7;

  deployer.deploy(StakingRewardsFactory, SKYLFI, secondsSinceEpoch + 100, { gas: 5000000 }).then((stakingRewardsFactory) => {
      let univ2 = '0x21B97C1641A4c9B69a783a7D581109267e851867';
      console.log("StakingRewardsFactory: " + StakingRewardsFactory.address);
      stakingRewardsFactory.deploy(SKYLFI, expandTo18Decimals(500000), nonWithdrawalBoost, nonWithdrawalBoostPeriod, minimumLockDays, false).then((result) => {
          console.log(result);
      })
      stakingRewardsFactory.deploy(univ2, expandTo18Decimals(500000), nonWithdrawalBoost, nonWithdrawalBoostPeriod, minimumLockDays, true).then((result) => {
        console.log(result);
      })
  });
};

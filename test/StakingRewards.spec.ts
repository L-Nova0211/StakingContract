import chai, { expect } from 'chai'
import { Contract, BigNumber, constants, Wallet } from 'ethers'
import { solidity, MockProvider, createFixtureLoader, deployContract } from 'ethereum-waffle'
import { ecsign } from 'ethereumjs-util'

import { pairFixture, stakingRewardsFixture, stakingRewardsLPFixture } from './fixtures'
import { REWARDS_DURATION, SIX_MONTHS, expandTo18Decimals, mineBlock, getApprovalDigest } from './utils'

import StakingRewards from '../build/StakingRewards.json'

chai.use(solidity)

const MINIMUM_LIQUIDITY = BigNumber.from("10").pow(3);

describe('StakingRewards', () => {
  const AddressZero = "0x0000000000000000000000000000000000000000"
  const provider = new MockProvider({
    ganacheOptions: {
      hardfork: 'istanbul',
      mnemonic: 'horn horn horn horn horn horn horn horn horn horn horn horn',
      gasLimit: 9999999,
    },
  })
  const [wallet, staker, secondStaker] = provider.getWallets()
  const loadFixture = createFixtureLoader([wallet, secondStaker], provider)
  const overrides = {
    gasLimit: 9999999
  }

  let stakingRewards: Contract
  let rewardsToken: Contract
  let stakingToken: Contract
  let nonWithdrawalBoost: BigNumber
  let nonWithdrawalBoostPeriod: number
  let minimumLockDays: number
  beforeEach(async () => {
    const fixture = await loadFixture(stakingRewardsFixture)
    stakingRewards = fixture.stakingRewards
    rewardsToken = fixture.rewardsToken
    stakingToken = fixture.stakingToken
    nonWithdrawalBoost = fixture.nonWithdrawalBoost
    nonWithdrawalBoostPeriod = fixture.nonWithdrawalBoostPeriod
    minimumLockDays = fixture.minimumLockDays
  })

  it('deploy cost', async () => {
    const stakingRewards = await deployContract(wallet, StakingRewards, [
      wallet.address,
      rewardsToken.address,
      stakingToken.address,
      nonWithdrawalBoost,
      nonWithdrawalBoostPeriod,
      minimumLockDays
    ])
    const receipt = await provider.getTransactionReceipt(stakingRewards.deployTransaction.hash)
    expect(receipt.gasUsed).to.eq('2788104')
  })

  it('rewardsDuration', async () => {
    const rewardsDuration = await stakingRewards.rewardsDuration()
    expect(rewardsDuration).to.be.eq(REWARDS_DURATION)
  })

  const reward = expandTo18Decimals(100)
  async function start(reward: BigNumber): Promise<{ startTime: BigNumber; endTime: BigNumber }> {
    // send reward to the contract
    await rewardsToken.transfer(stakingRewards.address, reward)
    // must be called by rewardsDistribution
    await stakingRewards.notifyRewardAmount(reward)

    const startTime: BigNumber = await stakingRewards.lastUpdateTime()
    const endTime: BigNumber = await stakingRewards.periodFinish()
    expect(endTime).to.be.eq(startTime.add(REWARDS_DURATION))
    return { startTime, endTime }
  }

  it('notifyRewardAmount: full', async () => {
    // stake with staker
    const stake = expandTo18Decimals(2)
    await stakingToken.transfer(staker.address, stake)
    await stakingToken.connect(staker).approve(stakingRewards.address, stake)
    await stakingRewards.connect(staker).stake(stake)
    const { endTime } = await start(reward)
    // fast-forward past the reward window
    await mineBlock(provider, endTime.add(1).toNumber())
    // unstake
    const { 0: startDate, 1: endDate, 2: amount, 3: lastWithdrawal } = await stakingRewards.getStakeDetails(staker.address);
    await stakingRewards.connect(staker).exit()
    const stakeEndTime: BigNumber = await stakingRewards.lastUpdateTime()
    expect(stakeEndTime).to.be.eq(endTime)

    const rewardAmount = await rewardsToken.balanceOf(staker.address)
    expect(reward.sub(rewardAmount).lte(reward.div(10000))).to.be.true // ensure result is within .01%
    expect(rewardAmount).to.be.eq(reward.div(REWARDS_DURATION).mul(REWARDS_DURATION))
  })

  it('stakeWithPermit', async () => {
    // stake with staker
    const stake = expandTo18Decimals(2)
    await stakingToken.transfer(staker.address, stake)

    // get permit
    const nonce = await stakingToken.nonces(staker.address)
    const deadline = constants.MaxUint256
    const digest = await getApprovalDigest(
      stakingToken,
      { owner: staker.address, spender: stakingRewards.address, value: stake },
      nonce,
      deadline
    )
    const { v, r, s } = ecsign(Buffer.from(digest.slice(2), 'hex'), Buffer.from(staker.privateKey.slice(2), 'hex'))
    await stakingRewards.connect(staker).stakeWithPermit(stake, deadline, v, r, s)
    const { endTime } = await start(reward)
    // fast-forward past the reward window
    await mineBlock(provider, endTime.add(1).toNumber())
    // unstake
    await stakingRewards.connect(staker).exit()
    const stakeEndTime: BigNumber = await stakingRewards.lastUpdateTime()
    expect(stakeEndTime).to.be.eq(endTime)

    const rewardAmount = await rewardsToken.balanceOf(staker.address)
    expect(reward.sub(rewardAmount).lte(reward.div(10000))).to.be.true // ensure result is within .01%
    expect(rewardAmount).to.be.eq(reward.div(REWARDS_DURATION).mul(REWARDS_DURATION))
  })

  it('notifyRewardAmount: ~half', async () => {
    const { startTime, endTime } = await start(reward)

    // fast-forward ~halfway through the reward window
    await mineBlock(provider, startTime.add(endTime.sub(startTime).div(2)).toNumber())

    // stake with staker
    const stake = expandTo18Decimals(2)
    await stakingToken.transfer(staker.address, stake)
    await stakingToken.connect(staker).approve(stakingRewards.address, stake)
    await stakingRewards.connect(staker).stake(stake)
    const stakeStartTime: BigNumber = await stakingRewards.lastUpdateTime()

    // fast-forward past the reward window
    await mineBlock(provider, endTime.add(1).toNumber())

    // unstake
    await stakingRewards.connect(staker).exit()
    const stakeEndTime: BigNumber = await stakingRewards.lastUpdateTime()
    expect(stakeEndTime).to.be.eq(endTime)

    const rewardAmount = await rewardsToken.balanceOf(staker.address)
    expect(reward.div(2).sub(rewardAmount).lte(reward.div(2).div(10000))).to.be.true // ensure result is within .01%
    expect(rewardAmount).to.be.eq(reward.div(REWARDS_DURATION).mul(endTime.sub(stakeStartTime)))
  }).retries(2) // TODO investigate flakiness

  it('notifyRewardAmount: two stakers', async () => {
    // stake with first staker
    const stake = expandTo18Decimals(2)
    await stakingToken.transfer(staker.address, stake)
    await stakingToken.connect(staker).approve(stakingRewards.address, stake)
    await stakingRewards.connect(staker).stake(stake)

    const { startTime, endTime } = await start(reward)

    // fast-forward ~halfway through the reward window
    await mineBlock(provider, startTime.add(endTime.sub(startTime).div(2)).toNumber())

    // stake with second staker
    await stakingToken.transfer(secondStaker.address, stake)
    await stakingToken.connect(secondStaker).approve(stakingRewards.address, stake)
    await stakingRewards.connect(secondStaker).stake(stake)

    // fast-forward past the reward window
    await mineBlock(provider, endTime.add(1).toNumber())

    // unstake
    await stakingRewards.connect(staker).exit()
    const stakeEndTime: BigNumber = await stakingRewards.lastUpdateTime()
    expect(stakeEndTime).to.be.eq(endTime)
    await stakingRewards.connect(secondStaker).exit()
    const rewardAmount = await rewardsToken.balanceOf(staker.address)
    const secondRewardAmount = await rewardsToken.balanceOf(secondStaker.address)
    const totalReward = rewardAmount.add(secondRewardAmount)

    // ensure results are within .01%
    expect(reward.sub(totalReward).lte(reward.div(10000))).to.be.true
    expect(totalReward.mul(3).div(4).sub(rewardAmount).lte(totalReward.mul(3).div(4).div(10000)))
    expect(totalReward.div(4).sub(secondRewardAmount).lte(totalReward.div(4).div(10000)))
  })

  describe('#skylaunch', () => {
    beforeEach(async () => {
      const fixture = await loadFixture(stakingRewardsFixture)
      stakingRewards = fixture.stakingRewards
      rewardsToken = fixture.rewardsToken
      stakingToken = fixture.stakingToken
      nonWithdrawalBoost = fixture.nonWithdrawalBoost
      nonWithdrawalBoostPeriod = fixture.nonWithdrawalBoostPeriod
      minimumLockDays = fixture.minimumLockDays
    })

    it('fails if minimum staking not met', async () => {

    })

    describe('#scoreMining', () => {
      it('initial score is 0', async () => {
        expect(await stakingRewards.getUserScore(staker.address)).to.be.eq(0);
      })

      it('score for user staked with permit', async () => {
        // stake with staker
        const stake = expandTo18Decimals(150000)
        await stakingToken.transfer(staker.address, stake)

        // get permit
        const nonce = await stakingToken.nonces(staker.address)
        const deadline = constants.MaxUint256
        const digest = await getApprovalDigest(
          stakingToken,
          { owner: staker.address, spender: stakingRewards.address, value: stake },
          nonce,
          deadline
        )
        const { v, r, s } = ecsign(Buffer.from(digest.slice(2), 'hex'), Buffer.from(staker.privateKey.slice(2), 'hex'))
        await stakingRewards.connect(staker).stakeWithPermit(stake, deadline, v, r, s)
        expect(await stakingRewards.getUserScore(staker.address)).to.be.eq(36474);
      })

      it('score for user staked with lock with permit - 30 days', async () => {
        // stake with staker
        const stake = expandTo18Decimals(5000)
        await stakingToken.transfer(staker.address, stake)

        // get permit
        const nonce = await stakingToken.nonces(staker.address)
        const deadline = constants.MaxUint256
        const digest = await getApprovalDigest(
          stakingToken,
          { owner: staker.address, spender: stakingRewards.address, value: stake },
          nonce,
          deadline
        )
        const { v, r, s } = ecsign(Buffer.from(digest.slice(2), 'hex'), Buffer.from(staker.privateKey.slice(2), 'hex'))
        await stakingRewards.connect(staker).stakeWithLockWithPermit(stake, 30, deadline, v, r, s)
        expect(await stakingRewards.getUserScore(staker.address)).to.be.eq(5210);
      })

      it('score for users without the lock', async () => {
        const stake = expandTo18Decimals(150000);
        await stakingToken.transfer(staker.address, stake)
        await stakingToken.connect(staker).approve(stakingRewards.address, stake)
        await stakingRewards.connect(staker).stake(stake)

        expect(await stakingRewards.getUserScore(staker.address)).to.be.eq(36474);
      })

      it('score for users without the lock - 180 days without withdrawal', async () => {
        const stake = expandTo18Decimals(5000)
        await stakingToken.transfer(secondStaker.address, stake)
        await stakingToken.connect(secondStaker).approve(stakingRewards.address, stake)
        await stakingRewards.connect(secondStaker).stake(stake)

        const { 0: startDate, 1: endDate, 2: amount, 3: lastWithdrawal } = await stakingRewards.getStakeDetails(secondStaker.address);

        // fast-forward past the reward window
        await mineBlock(provider, startDate.add(SIX_MONTHS).add(1).toNumber())

        expect(await stakingRewards.getUserScore(secondStaker.address)).to.be.eq(6264);
      })

      it('score for users with the long term lock 20 days', async () => {
        const stake = expandTo18Decimals(5000)
        await stakingToken.transfer(staker.address, stake)
        await stakingToken.connect(staker).approve(stakingRewards.address, stake)
        await stakingRewards.connect(staker).stakeWithLock(stake, 20)
        //const { endTime } = await start(reward)

        //const stakeStartTime: BigNumber = await stakingRewards.lastUpdateTime()

        const { 0: startDate, 1: endDate, 2: amount, 3: lastWithdrawal } = await stakingRewards.getStakeDetails(staker.address);

        expect(await stakingRewards.getUserScore(staker.address)).to.be.eq(3473);
      })

      it('score for users with the long term lock 30 days', async () => {
        const stake = expandTo18Decimals(5000)
        await stakingToken.transfer(staker.address, stake)
        await stakingToken.connect(staker).approve(stakingRewards.address, stake)
        await stakingRewards.connect(staker).stakeWithLock(stake, 30)
        //const { endTime } = await start(reward)

        //const stakeStartTime: BigNumber = await stakingRewards.lastUpdateTime()

        const { 0: startDate, 1: endDate, 2: amount, 3: lastWithdrawal } = await stakingRewards.getStakeDetails(staker.address);

        expect(await stakingRewards.getUserScore(staker.address)).to.be.eq(5210);
      })

      it('score for users with the long term lock 180 days', async () => {
        const stake = expandTo18Decimals(5000)
        await stakingToken.transfer(staker.address, stake)
        await stakingToken.connect(staker).approve(stakingRewards.address, stake)
        await stakingRewards.connect(staker).stakeWithLock(stake, 180)
        //const { endTime } = await start(reward)

        //const stakeStartTime: BigNumber = await stakingRewards.lastUpdateTime()

        const { 0: startDate, 1: endDate, 2: amount, 3: lastWithdrawal } = await stakingRewards.getStakeDetails(staker.address);

        expect(await stakingRewards.getUserScore(staker.address)).to.be.eq(6264);
      })



    })

    describe('#stakingWithLPtokens', () => {
      const provider = new MockProvider({
        ganacheOptions: {
          hardfork: 'istanbul',
          mnemonic: 'horn horn horn horn horn horn horn horn horn horn horn horn',
          gasLimit: 9999999,
        },
      })
      const [wallet, staker, secondStaker] = provider.getWallets()
      const loadFixture = createFixtureLoader([wallet], provider)

      let token0: Contract;
      let token1: Contract;
      let pair: Contract;

      async function addLiquidity(staker: Wallet, token0Amount: number, token1Amount: number) {
        await token0.connect(staker).transfer(pair.address, expandTo18Decimals(token0Amount))
        await token1.connect(staker).transfer(pair.address, expandTo18Decimals(token1Amount))
        await pair.connect(staker).mint(staker.address, overrides)
      }

      beforeEach(async () => {
        const fixture = await loadFixture(stakingRewardsLPFixture)
        pair = fixture.pair
        token0 = fixture.token0
        token1 = fixture.token1
        stakingRewards = fixture.stakingRewards
        rewardsToken = fixture.rewardsToken
        stakingToken = fixture.stakingToken
        nonWithdrawalBoost = fixture.nonWithdrawalBoost
        nonWithdrawalBoostPeriod = fixture.nonWithdrawalBoostPeriod
        minimumLockDays = fixture.minimumLockDays

        await addLiquidity(wallet, 4, 1);
        await token0.transfer(staker.address, expandTo18Decimals(150000));
        await token1.transfer(staker.address, expandTo18Decimals(37500));
      })

      it('initial score is 0', async () => {
        expect(await stakingRewards.getUserScore(staker.address)).to.be.eq(0);
      })

      it('score for user staked with permit', async () => {
        // stake with staker
        await addLiquidity(staker, 150000, 37500);

        const stake = await pair.balanceOf(staker.address);

        // get permit
        const nonce = await stakingToken.nonces(staker.address)
        const deadline = constants.MaxUint256
        const digest = await getApprovalDigest(
          stakingToken,
          { owner: staker.address, spender: stakingRewards.address, value: stake },
          nonce,
          deadline
        )
        const { v, r, s } = ecsign(Buffer.from(digest.slice(2), 'hex'), Buffer.from(staker.privateKey.slice(2), 'hex'))
        await stakingRewards.connect(staker).stakeWithPermit(stake, deadline, v, r, s)
        expect(await stakingRewards.getUserScore(staker.address)).to.be.eq(45593);
      })

      it('score for user staked with lock with permit - 30 days', async () => {
        // stake with staker
        await addLiquidity(staker, 5000, 1250);

        const stake = await pair.balanceOf(staker.address);

        // get permit
        const nonce = await stakingToken.nonces(staker.address)
        const deadline = constants.MaxUint256
        const digest = await getApprovalDigest(
          stakingToken,
          { owner: staker.address, spender: stakingRewards.address, value: stake },
          nonce,
          deadline
        )
        const { v, r, s } = ecsign(Buffer.from(digest.slice(2), 'hex'), Buffer.from(staker.privateKey.slice(2), 'hex'))
        await stakingRewards.connect(staker).stakeWithLockWithPermit(stake, 30, deadline, v, r, s)
        expect(await stakingRewards.getUserScore(staker.address)).to.be.eq(6513);
      })

      
      it('score for users without the lock', async () => {
        // stake with staker
        await addLiquidity(staker, 150000, 37500);
        const stake = await pair.balanceOf(staker.address);

        await stakingToken.connect(staker).approve(stakingRewards.address, stake)
        await stakingRewards.connect(staker).stake(stake)
        
        expect(await stakingRewards.getUserScore(staker.address)).to.be.eq(45593);
      })

      it('score for users without the lock - 180 days without withdrawal', async () => {
        await addLiquidity(staker, 5000, 1250);
        const stake = await pair.balanceOf(staker.address);

        await stakingToken.connect(staker).approve(stakingRewards.address, stake)
        await stakingRewards.connect(staker).stake(stake)

        const {0: startDate, 1: endDate, 2: amount, 3: lastWithdrawal } = await stakingRewards.getStakeDetails(staker.address);

        // fast-forward past the reward window
        await mineBlock(provider, startDate.add(SIX_MONTHS).add(1).toNumber())

        expect(await stakingRewards.getUserScore(staker.address)).to.be.eq(7830);
      })

      it('score for users with the long term lock 20 days', async () => {
        await addLiquidity(staker, 5000, 1250);
        const stake = await pair.balanceOf(staker.address);
        await stakingToken.connect(staker).approve(stakingRewards.address, stake)
        await stakingRewards.connect(staker).stakeWithLock(stake, 20)

        const {0: startDate, 1: endDate, 2: amount, 3: lastWithdrawal } = await stakingRewards.getStakeDetails(staker.address);
        
        expect(await stakingRewards.getUserScore(staker.address)).to.be.eq(4342);
      })

      it('score for users with the long term lock 30 days', async () => {
        await addLiquidity(staker, 5000, 1250);
        const stake = await pair.balanceOf(staker.address);
        await stakingToken.connect(staker).approve(stakingRewards.address, stake)
        await stakingRewards.connect(staker).stakeWithLock(stake, 30)
        //const { endTime } = await start(reward)
  
        //const stakeStartTime: BigNumber = await stakingRewards.lastUpdateTime()

        const {0: startDate, 1: endDate, 2: amount, 3: lastWithdrawal } = await stakingRewards.getStakeDetails(staker.address);
        
        expect(await stakingRewards.getUserScore(staker.address)).to.be.eq(6513);
      })

      it('score for users with the long term lock 180 days', async () => {
        await addLiquidity(staker, 5000, 1250);
        const stake = await pair.balanceOf(staker.address);
        await stakingToken.connect(staker).approve(stakingRewards.address, stake)
        await stakingRewards.connect(staker).stakeWithLock(stake, 180)

        const {0: startDate, 1: endDate, 2: amount, 3: lastWithdrawal } = await stakingRewards.getStakeDetails(staker.address);
        
        expect(await stakingRewards.getUserScore(staker.address)).to.be.eq(7830);
      })
    })

    describe('#stakingWithLocks', () => {
      it('staking with lock', async () => {
        // stake with staker
        const stake = expandTo18Decimals(10)
        const lockDays = 30;
        await stakingToken.transfer(staker.address, stake)
        await stakingToken.connect(staker).approve(stakingRewards.address, stake)
        await stakingRewards.connect(staker).stakeWithLock(stake, lockDays)
        const { endTime } = await start(reward)

        const stakeStartTime: BigNumber = await stakingRewards.lastUpdateTime()

        const { 0: startDate, 1: endDate, 2: amount, 3: lastWithdrawal } = await stakingRewards.getStakeDetails(staker.address);

        // fast-forward past the reward window
        await mineBlock(provider, endDate.add(1).toNumber())

        // unstake
        await stakingRewards.connect(staker).exit()

        expect(await stakingToken.balanceOf(staker.address)).to.be.eq(stake);
      })

      it('can\'t exit before the lock expires', async () => {
        // stake with staker
        const stake = expandTo18Decimals(10)
        const lockDays = 30;
        await stakingToken.transfer(staker.address, stake)
        await stakingToken.connect(staker).approve(stakingRewards.address, stake)
        await stakingRewards.connect(staker).stakeWithLock(stake, lockDays)
        const { endTime } = await start(reward)

        const stakeStartTime: BigNumber = await stakingRewards.lastUpdateTime()

        const { 0: startDate, 1: endDate, 2: amount, 3: lastWithdrawal } = await stakingRewards.getStakeDetails(staker.address);

        // fast-forward past the reward window
        await mineBlock(provider, endDate.sub(1).toNumber())

        // unstake
        await expect(stakingRewards.connect(staker).exit()).to.be.revertedWith(
          '[Withdraw] The unstaking is not allowed until your lock expires'
        )
      })

      it('minimum lock is applied for standard staking', async () => {
        const stake = expandTo18Decimals(10)
        const minLockDays = BigNumber.from(minimumLockDays * 60 * 60 * 24);
        await stakingToken.transfer(staker.address, stake)
        await stakingToken.connect(staker).approve(stakingRewards.address, stake)
        await stakingRewards.connect(staker).stake(stake)
        const { endTime } = await start(reward)

        const stakeStartTime: BigNumber = await stakingRewards.lastUpdateTime()

        const { 0: startDate, 1: endDate, 2: amount, 3: lastWithdrawal } = await stakingRewards.getStakeDetails(staker.address);

        // fast-forward past the reward window
        await mineBlock(provider, stakeStartTime.add(minLockDays).sub(1).toNumber())

        // unstake
        await expect(stakingRewards.connect(staker).exit()).to.be.revertedWith(
          '[Withdraw] The unstaking is not allowed until your lock expires'
        )

        await mineBlock(provider, stakeStartTime.add(minLockDays).add(1).toNumber())

        await stakingRewards.connect(staker).exit()
        expect(await stakingToken.balanceOf(staker.address)).to.be.eq(stake);
      })
    })
  })
})

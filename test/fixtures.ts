import chai from 'chai'
import { Contract, Wallet, BigNumber, providers } from 'ethers'
import { solidity, deployContract } from 'ethereum-waffle'

import { expandTo18Decimals, expandTo17Decimals } from './utils'
import UniswapV2ERC20 from '@uniswap/v2-core/build/ERC20.json'
import UniswapV2Pair from '@uniswap/v2-core/build/UniswapV2Pair.json'
import UniswapV2Factory from '@uniswap/v2-core/build/UniswapV2Factory.json'
import TestERC20 from '../build/TestERC20.json'
import StakingRewards from '../build/StakingRewards.json'
import StakingRewardsFactory from '../build/StakingRewardsFactory.json'
import { Address } from 'ethereumjs-util'

chai.use(solidity)

const NUMBER_OF_STAKING_TOKENS = 4

const nonWithdrawalBoost = expandTo17Decimals(5);
const nonWithdrawalBoostPeriod = 356;
const minimumLockDays = 7;

interface StakingRewardsFixture {
  stakingRewards: Contract
  rewardsToken: Contract
  stakingToken: Contract
  nonWithdrawalBoost: BigNumber
  nonWithdrawalBoostPeriod: number
  minimumLockDays: number
}

interface StakingRewardsLPFixture {
  pair: Contract,
  token0: Contract,
  token1: Contract,
  stakingRewards: Contract
  rewardsToken: Contract
  stakingToken: Contract
  nonWithdrawalBoost: BigNumber
  nonWithdrawalBoostPeriod: number
  minimumLockDays: number
}

interface FactoryFixture {
  factory: Contract
}

const overrides = {
  gasLimit: 9999999
}

export async function factoryFixture([wallet]: Wallet[], _: providers.Web3Provider): Promise<FactoryFixture> {
  const factory = await deployContract(wallet, UniswapV2Factory, [wallet.address], overrides)
  return { factory }
}

interface PairFixture extends FactoryFixture {
  token0: Contract
  token1: Contract
  pair: Contract
}

export async function pairFixture([wallet]: Wallet[], provider: providers.Web3Provider): Promise<PairFixture> {
  const { factory } = await factoryFixture([wallet], provider)

  const tokenA = await deployContract(wallet, TestERC20, [expandTo18Decimals(1000000)], overrides)
  const tokenB = await deployContract(wallet, TestERC20, [expandTo18Decimals(1000000)], overrides)

  await factory.createPair(tokenA.address, tokenB.address, overrides)
  const pairAddress = await factory.getPair(tokenA.address, tokenB.address)
  const pair = new Contract(pairAddress, JSON.stringify(UniswapV2Pair.abi), provider).connect(wallet)

  const token0Address = (await pair.token0()).address
  const token0 = tokenA.address === token0Address ? tokenA : tokenB
  const token1 = tokenA.address === token0Address ? tokenB : tokenA

  return { factory, token0, token1, pair }
}

export async function stakingRewardsLPFixture([wallet, wallet2]: Wallet[], provider: providers.Web3Provider): Promise<StakingRewardsLPFixture> {

  //const { factory, token0, token1, pair } = await pairFixture([wallet, wallet2], provider)
  const { factory } = await factoryFixture([wallet], provider)

  const tokenA = await deployContract(wallet, TestERC20, [expandTo18Decimals(1000000)])
  const tokenB = await deployContract(wallet, TestERC20, [expandTo18Decimals(1000000)])

  await factory.createPair(tokenA.address, tokenB.address, overrides)
  const pairAddress = await factory.getPair(tokenA.address, tokenB.address)
  const pair = new Contract(pairAddress, JSON.stringify(UniswapV2Pair.abi), provider).connect(wallet)

  const token0Address = await pair.token0()
  const token0 = tokenA.address === token0Address ? tokenA : tokenB
  const token1 = tokenA.address === token0Address ? tokenB : tokenA

  const rewardsDistribution = wallet.address
  const rewardsToken = token0;
  const stakingToken = pair;

  const stakingRewards = await deployContract(wallet, StakingRewards, [
    rewardsDistribution,
    rewardsToken.address,
    stakingToken.address,
    nonWithdrawalBoost,
    nonWithdrawalBoostPeriod,
    minimumLockDays,
    true
  ])

  return { pair, token0, token1, stakingRewards, rewardsToken, stakingToken, nonWithdrawalBoost, nonWithdrawalBoostPeriod, minimumLockDays }
}

export async function stakingRewardsFixture([wallet]: Wallet[]): Promise<StakingRewardsFixture> {
  const rewardsDistribution = wallet.address
  const rewardsToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1000000)])
  const stakingToken = await deployContract(wallet, UniswapV2ERC20, [expandTo18Decimals(1000000)])

  const stakingRewards = await deployContract(wallet, StakingRewards, [
    rewardsDistribution,
    rewardsToken.address,
    stakingToken.address,
    nonWithdrawalBoost,
    nonWithdrawalBoostPeriod,
    minimumLockDays,
    false
  ])

  return { stakingRewards, rewardsToken, stakingToken, nonWithdrawalBoost, nonWithdrawalBoostPeriod, minimumLockDays }
}

interface StakingRewardsFactoryFixture {
  rewardsToken: Contract
  stakingTokens: Contract[]
  genesis: number
  rewardAmounts: BigNumber[]
  stakingRewardsFactory: Contract
  nonWithdrawalBoosts: BigNumber[]
  nonWithdrawalBoostPeriods: number[]
  minimumLockDaysArray: number[]
}

export async function stakingRewardsFactoryFixture(
  [wallet]: Wallet[],
  provider: providers.Web3Provider
): Promise<StakingRewardsFactoryFixture> {
  const rewardsToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000_000)])

  // deploy staking tokens
  const stakingTokens = []
  for (let i = 0; i < NUMBER_OF_STAKING_TOKENS; i++) {
    const stakingToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000_000)])
    stakingTokens.push(stakingToken)
  }

  // deploy the staking rewards factory
  const { timestamp: now } = await provider.getBlock('latest')
  const genesis = now + 60 * 60
  const rewardAmounts: BigNumber[] = new Array(stakingTokens.length).fill(expandTo18Decimals(10))
  const nonWithdrawalBoosts: BigNumber[] = new Array(stakingTokens.length).fill(expandTo17Decimals(5))
  const nonWithdrawalBoostPeriods: number[] = new Array(stakingTokens.length).fill(nonWithdrawalBoostPeriod)
  const minimumLockDaysArray: number[] = new Array(stakingTokens.length).fill(minimumLockDays)
  const stakingRewardsFactory = await deployContract(wallet, StakingRewardsFactory, [rewardsToken.address, genesis])

  return { rewardsToken, stakingTokens, genesis, rewardAmounts, stakingRewardsFactory, nonWithdrawalBoosts, nonWithdrawalBoostPeriods, minimumLockDaysArray }
}

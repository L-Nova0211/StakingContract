pragma solidity >=0.5.16;

import "openzeppelin-solidity-2.3.0/contracts/math/Math.sol";
import "openzeppelin-solidity-2.3.0/contracts/math/SafeMath.sol";
import "openzeppelin-solidity-2.3.0/contracts/token/ERC20/ERC20Detailed.sol";
import "openzeppelin-solidity-2.3.0/contracts/token/ERC20/SafeERC20.sol";
import "openzeppelin-solidity-2.3.0/contracts/utils/ReentrancyGuard.sol";

// Inheritance
import "./interfaces/IStakingRewards.sol";
import "./RewardsDistributionRecipient.sol";

import "./uniswap/UniswapV2LiquidityMathLibrary.sol";
import "./uniswap/UniswapV2Library.sol";

contract StakingRewards is IStakingRewards, RewardsDistributionRecipient, ReentrancyGuard {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    /* ========== STATE VARIABLES ========== */

    IERC20 public rewardsToken;
    IERC20 public stakingToken;
    uint256 public periodFinish = 0;
    uint256 public rewardRate = 0;
    uint256 public rewardsDuration = 60 days;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;
    bool public isLPToken;

    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;

    mapping(address => StakeDeposit) private _stakeDeposits;
    uint256 public minimumLockDays;

    uint256 public nonWithdrawalBoost;
    uint256 public nonWithdrawalBoostPeriod;

    /* ========== STRUCT DECLARATIONS ========== */

    struct StakeDeposit {
        uint256 amount;
        uint256 startDate;
        uint256 endDate;
        uint256 lastWithdrawal;
        uint256 entryRewardPoints;
        uint256 exitRewardPoints;
        bool exists;
    }

    /* ========== CONSTRUCTOR ========== */

    constructor(
        address _rewardsDistribution,
        address _rewardsToken,
        address _stakingToken,
        uint256 _nonWithdrawalBoost,
        uint256 _nonWithdrawalBoostPeriod,
        uint256 _minimumLockDays,
        bool _isLPToken
    ) public {
        rewardsToken = IERC20(_rewardsToken);
        stakingToken = IERC20(_stakingToken);
        rewardsDistribution = _rewardsDistribution;
        nonWithdrawalBoost = _nonWithdrawalBoost;
        nonWithdrawalBoostPeriod = _nonWithdrawalBoostPeriod;
        minimumLockDays = _minimumLockDays;
        isLPToken = _isLPToken;
    }

    /* ========== VIEWS ========== */

    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return Math.min(block.timestamp, periodFinish);
    }

    function rewardPerToken() public view returns (uint256) {
        if (_totalSupply == 0) {
            return rewardPerTokenStored;
        }
        return
            rewardPerTokenStored.add(
                lastTimeRewardApplicable().sub(lastUpdateTime).mul(rewardRate).mul(1e18).div(_totalSupply)
            );
    }

    function earned(address account) public view returns (uint256) {
        return _balances[account].mul(rewardPerToken().sub(userRewardPerTokenPaid[account])).div(1e18).add(rewards[account]);
    }

    function getRewardForDuration() external view returns (uint256) {
        return rewardRate.mul(rewardsDuration);
    }

    function getUserScore(address account) public view returns (uint256) {
        StakeDeposit memory stakeDeposit = _stakeDeposits[account];
        if(stakeDeposit.amount == 0)
            return 0;

        uint256 daysSinceLastWithdrawal = block.timestamp.sub(stakeDeposit.lastWithdrawal).div(1 days);

        if(stakeDeposit.endDate > block.timestamp){
            daysSinceLastWithdrawal = daysSinceLastWithdrawal.add(stakeDeposit.endDate.sub(block.timestamp).div(1 days));
        }

        // check if this is LP token
        uint256 tokenAmount;
        if(isLPToken){
            tokenAmount = getLPRewardsTokenAmountForUser(account);
            if(tokenAmount == 0)
                return 0;

            tokenAmount = tokenAmount.mul(1250000000000000000).div(10**18);
        }
        else{
            tokenAmount = stakeDeposit.amount;
        }

        uint256 amountScore = daysSinceLastWithdrawal >= 30 ? tokenAmount : tokenAmount.mul(daysSinceLastWithdrawal).div(30);
        uint256 amount = tokenAmount.div(10**18);
        uint256 score = amountScore + amount.mul(daysSinceLastWithdrawal).div(nonWithdrawalBoostPeriod).mul(nonWithdrawalBoost);
        score = score.div(10**18);
        return score;
    }

    // higher level function should do validations
    function getLPRewardsTokenAmountForUser(address account) internal view returns (uint256) {
        StakeDeposit memory stakeDeposit = _stakeDeposits[account];
        IUniswapV2Pair pair = IUniswapV2Pair(address(stakingToken));
        
        (uint256 _token0, uint256 _token1) = UniswapV2LiquidityMathLibrary.getLiquidityValue(pair.factory(), pair.token0(), pair.token1(), stakeDeposit.amount);
        
        if(pair.token0() == address(rewardsToken)){
            return _token0;
        }
        else if(pair.token1() == address(rewardsToken)){
            return _token1;
        }
        else{
            return 0;
        }
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    function stakeWithPermit(uint256 amount, uint deadline, uint8 v, bytes32 r, bytes32 s) external nonReentrant {
        require(amount > 0, "Cannot stake 0");
        _totalSupply = _totalSupply.add(amount);
        _balances[msg.sender] = _balances[msg.sender].add(amount);

        StakeDeposit storage stakeDeposit = _stakeDeposits[msg.sender];
        stakeDeposit.amount = stakeDeposit.amount.add(amount);
        stakeDeposit.startDate = block.timestamp;
        
        if(stakeDeposit.lastWithdrawal == 0){
            stakeDeposit.lastWithdrawal = block.timestamp;
        }

        if(stakeDeposit.endDate == 0){
            stakeDeposit.endDate = block.timestamp.add(minimumLockDays * 1 days);
        }
        else{
            if(block.timestamp.add(minimumLockDays * 1 days) > stakeDeposit.endDate){
                stakeDeposit.endDate = block.timestamp.add(minimumLockDays * 1 days);
            }
        }

        stakeDeposit.exists = true;

        // permit
        IUniswapV2ERC20(address(stakingToken)).permit(msg.sender, address(this), amount, deadline, v, r, s);

        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function stakeWithLockWithPermit(uint256 amount, uint256 daysDuration, uint deadline, uint8 v, bytes32 r, bytes32 s) external nonReentrant {
        require(amount > 0, "Cannot stake 0");
        _totalSupply = _totalSupply.add(amount);
        _balances[msg.sender] = _balances[msg.sender].add(amount);

        StakeDeposit storage stakeDeposit = _stakeDeposits[msg.sender];
        stakeDeposit.amount = stakeDeposit.amount.add(amount);
        stakeDeposit.startDate = block.timestamp;
        
        if(stakeDeposit.lastWithdrawal == 0){
            stakeDeposit.lastWithdrawal = block.timestamp;
        }

        if(stakeDeposit.endDate == 0){
            stakeDeposit.endDate = block.timestamp.add(daysDuration * 1 days);
        }
        else{
            if(block.timestamp.add(daysDuration * 1 days) > stakeDeposit.endDate){
                stakeDeposit.endDate = block.timestamp.add(daysDuration * 1 days);
            }
        }

        stakeDeposit.exists = true;

        // permit
        IUniswapV2ERC20(address(stakingToken)).permit(msg.sender, address(this), amount, deadline, v, r, s);

        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit StakedWithLock(msg.sender, amount, daysDuration);
    }

    function stakeWithLock(uint256 amount, uint256 daysDuration) external nonReentrant updateReward(msg.sender) {
        StakeDeposit storage stakeDeposit = _stakeDeposits[msg.sender];

        if(stakeDeposit.endDate == 0){
            stakeDeposit.endDate = block.timestamp.add(daysDuration * 1 days);
        }
        else{
            if(block.timestamp.add(daysDuration * 1 days) > stakeDeposit.endDate){
                stakeDeposit.endDate = block.timestamp.add(daysDuration * 1 days);
            }
        }

        _stake(amount);

        emit StakedWithLock(msg.sender, amount, daysDuration);
    }

    function stake(uint256 amount) external nonReentrant updateReward(msg.sender){
        StakeDeposit storage stakeDeposit = _stakeDeposits[msg.sender];

        if(stakeDeposit.endDate == 0){
            stakeDeposit.endDate = block.timestamp.add(minimumLockDays * 1 days);
        }
        else{
            if(block.timestamp.add(minimumLockDays * 1 days) > stakeDeposit.endDate){
                stakeDeposit.endDate = block.timestamp.add(minimumLockDays * 1 days);
            }
        }

        _stake(amount);
    }

    function _stake(uint256 amount) internal  {
        require(amount > 0, "Cannot stake 0");
        _totalSupply = _totalSupply.add(amount);
        _balances[msg.sender] = _balances[msg.sender].add(amount);

        StakeDeposit storage stakeDeposit = _stakeDeposits[msg.sender];
        stakeDeposit.amount = stakeDeposit.amount.add(amount);
        stakeDeposit.startDate = block.timestamp;
        
        if(stakeDeposit.lastWithdrawal == 0){
            stakeDeposit.lastWithdrawal = block.timestamp;
        }

        stakeDeposit.exists = true;
        //stakeDeposit.entryRewardPoints = totalRewardPoints;

        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function getStakeDetails(address account) external view returns (uint256, uint256, uint256, uint256){
        StakeDeposit memory stakeDeposit = _stakeDeposits[account];

        return (stakeDeposit.startDate, stakeDeposit.endDate, stakeDeposit.amount, stakeDeposit.lastWithdrawal);
    }

    function withdraw(uint256 amount) public nonReentrant updateReward(msg.sender) {
        require(amount > 0, "Cannot withdraw 0");

        StakeDeposit storage stakeDeposit = _stakeDeposits[msg.sender];
        require(stakeDeposit.endDate < block.timestamp, "[Withdraw] The unstaking is not allowed until your lock expires");

        stakeDeposit.amount = stakeDeposit.amount.sub(amount);
        stakeDeposit.lastWithdrawal = block.timestamp;

        _totalSupply = _totalSupply.sub(amount);
        _balances[msg.sender] = _balances[msg.sender].sub(amount);


        stakingToken.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    function getReward() public nonReentrant updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            rewardsToken.safeTransfer(msg.sender, reward);
            emit RewardPaid(msg.sender, reward);
        }
    }

    function exit() external {
        withdraw(_balances[msg.sender]);
        getReward();
    }



    /* ========== RESTRICTED FUNCTIONS ========== */

    function notifyRewardAmount(uint256 reward) external onlyRewardsDistribution updateReward(address(0)) {
        if (block.timestamp >= periodFinish) {
            rewardRate = reward.div(rewardsDuration);
        } else {
            uint256 remaining = periodFinish.sub(block.timestamp);
            uint256 leftover = remaining.mul(rewardRate);
            rewardRate = reward.add(leftover).div(rewardsDuration);
        }

        // Ensure the provided reward amount is not more than the balance in the contract.
        // This keeps the reward rate in the right range, preventing overflows due to
        // very high values of rewardRate in the earned and rewardsPerToken functions;
        // Reward + leftover must be less than 2^256 / 10^18 to avoid overflow.
        uint balance = rewardsToken.balanceOf(address(this));
        require(rewardRate <= balance.div(rewardsDuration), "Provided reward too high");

        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp.add(rewardsDuration);
        emit RewardAdded(reward);
    }

    /* ========== MODIFIERS ========== */

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    /* ========== EVENTS ========== */

    event RewardAdded(uint256 reward);
    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event StakedWithLock(address indexed user, uint256 amount, uint256 daysDuration);
}

interface IUniswapV2ERC20 {
    function permit(address owner, address spender, uint value, uint deadline, uint8 v, bytes32 r, bytes32 s) external;
}

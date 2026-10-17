// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * CrossCheck 存证合约
 * 功能：记录双模型审核结果的哈希指纹
 */
contract CrossCheck {
    // 凭证计数器
    uint256 public certificateCount;

    // 授权的发证地址（团队赞助钱包）
    address public issuer;

    event IssuerTransferred(address indexed previousIssuer, address indexed newIssuer);

    // 存证事件
    event Certified(
        uint256 indexed id,
        address indexed issuer,
        bytes32 contentHash,
        bytes32 verdictHash,
        uint8 agreement,
        uint256 timestamp
    );

    constructor() {
        issuer = msg.sender;
        emit IssuerTransferred(address(0), msg.sender);
    }

    /**
     * 提交存证
     * @param contentHash 原文内容的 Keccak-256 哈希
     * @param verdictHash 完整报告的 Keccak-256 哈希
     * @param agreement 意见一致性：0=一致, 1=分歧, 2=无法判断
     */
    function certify(
        bytes32 contentHash,
        bytes32 verdictHash,
        uint8 agreement
    ) external returns (uint256) {
        // 只允许授权地址提交
        require(msg.sender == issuer, "Only issuer can certify");

        // agreement 必须是 0, 1, 或 2
        require(agreement <= 2, "Invalid agreement value");

        // 增加凭证编号
        certificateCount++;

        // 发出事件
        emit Certified(
            certificateCount,
            msg.sender,
            contentHash,
            verdictHash,
            agreement,
            block.timestamp
        );

        return certificateCount;
    }

    /**
     * 更改授权地址（仅限当前 issuer）
     */
    function transferIssuer(address newIssuer) external {
        require(msg.sender == issuer, "Only issuer");
        require(newIssuer != address(0), "Invalid address");
        emit IssuerTransferred(issuer, newIssuer);
        issuer = newIssuer;
    }
}

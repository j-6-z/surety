// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

/// @dev Test-only stand-in for the ERC-8004 Identity Registry: the functions and events
///      scripts/register-agent.js uses, with the same shapes as the reference contract.
contract MockIdentityRegistry is ERC721URIStorage {
    uint256 private _lastId;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);

    constructor() ERC721("AgentIdentity", "AGENT") {}

    function register(string memory agentURI) external returns (uint256 agentId) {
        agentId = ++_lastId;
        _safeMint(msg.sender, agentId);
        _setTokenURI(agentId, agentURI);
        emit Registered(agentId, agentURI, msg.sender);
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        require(ownerOf(agentId) == msg.sender, "Not authorized");
        _setTokenURI(agentId, newURI);
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return ownerOf(agentId);
    }
}

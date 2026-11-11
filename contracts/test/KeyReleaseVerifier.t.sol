// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";

import {KeyReleaseVerifier} from "../src/delivery/KeyReleaseVerifier.sol";

contract VerifierHarness {
    function proveFault(bytes calldata c, bytes32 key, bytes32 keyHash, bytes32 ciphertextHash, bytes32 plaintextHash)
        external
        pure
        returns (bool)
    {
        return KeyReleaseVerifier.proveFault(c, key, keyHash, ciphertextHash, plaintextHash);
    }

    function decrypt(bytes calldata c, bytes32 key) external pure returns (bytes memory) {
        return KeyReleaseVerifier.decrypt(c, key);
    }
}

/// The dispute predicate, and its gas at the size limit.
contract KeyReleaseVerifierTest is Test {
    VerifierHarness v;

    function setUp() public {
        v = new VerifierHarness();
    }

    /// What an honest vendor does off chain: the same keystream.
    function _encrypt(bytes memory m, bytes32 key) internal pure returns (bytes memory c) {
        c = new bytes(m.length);
        for (uint256 i = 0; i < m.length; i++) {
            bytes32 pad = keccak256(abi.encodePacked(key, i / 32));
            c[i] = m[i] ^ pad[i % 32];
        }
    }

    function _data(uint256 n, bytes32 seed) internal pure returns (bytes memory m) {
        m = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            m[i] = bytes1(uint8(uint256(keccak256(abi.encodePacked(seed, i)))));
        }
    }

    function testDecryptionInvertsEncryptionAtEveryLength(uint16 lengthSeed, bytes32 key) public view {
        bytes memory m = _data(bound(lengthSeed, 0, 300), key);
        assertEq(v.decrypt(_encrypt(m, key), key), m);
    }

    function testAnHonestDeliveryHasNoFault() public view {
        bytes32 key = keccak256("k");
        bytes memory m = _data(4096, "honest");
        bytes memory c = _encrypt(m, key);
        assertFalse(v.proveFault(c, key, keccak256(abi.encodePacked(key)), keccak256(c), keccak256(m)));
    }

    /// The vendor committed to m, but the ciphertext it sent opens to something else.
    function testJunkBehindAValidKeyIsAFault() public view {
        bytes32 key = keccak256("k");
        bytes memory promised = _data(1024, "promised");
        bytes memory c = _encrypt(_data(1024, "junk"), key);
        assertTrue(v.proveFault(c, key, keccak256(abi.encodePacked(key)), keccak256(c), keccak256(promised)));
    }

    /// A buyer cannot dispute with a ciphertext the vendor never committed to, nor with
    /// a key the vendor did not publish.
    function testAFalseDisputeIsRefused() public {
        bytes32 key = keccak256("k");
        bytes memory m = _data(512, "m");
        bytes memory c = _encrypt(m, key);
        bytes memory other = _encrypt(_data(512, "other"), key);
        vm.expectRevert(KeyReleaseVerifier.NotTheCommittedCiphertext.selector);
        v.proveFault(other, key, keccak256(abi.encodePacked(key)), keccak256(c), keccak256(m));
        vm.expectRevert(KeyReleaseVerifier.NotTheCommittedKey.selector);
        v.proveFault(c, keccak256("not k"), keccak256(abi.encodePacked(key)), keccak256(c), keccak256(m));
        vm.expectRevert(KeyReleaseVerifier.CiphertextTooLong.selector);
        v.proveFault(new bytes(4097), key, keccak256(abi.encodePacked(key)), keccak256(c), keccak256(m));
    }

    /// The figure the paper quotes: a dispute at the size limit.
    function testGasOfADisputeAtTheLimit() public {
        bytes32 key = keccak256("k");
        bytes memory m = _data(4096, "limit");
        bytes memory c = _encrypt(m, key);
        bytes32 kh = keccak256(abi.encodePacked(key));
        bytes32 ch = keccak256(c);
        bytes32 mh = keccak256(m);
        uint256 before = gasleft();
        v.proveFault(c, key, kh, ch, mh);
        emit log_named_uint("execution gas, 4096-byte dispute", before - gasleft());
    }
}

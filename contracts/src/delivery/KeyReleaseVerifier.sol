// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title KeyReleaseVerifier: the dispute predicate of the key-release exchange
///
/// @notice The specified delivery protocol (paper, Section 6) sells a digital good as a
/// ciphertext the buyer holds and a key the vendor publishes to be paid. Its one dispute
/// predicate is decided here, entirely on chain:
///
///   the ciphertext the vendor committed to (h_c), decrypted under the key it published
///   (H(k) = h), is not the plaintext it committed to (h_m).
///
/// The cipher is a keccak keystream, chosen so the contract can decrypt cheaply:
///   block i of the plaintext = block i of c  XOR  keccak256(k, i),   32-byte blocks.
/// It is a stream cipher in counter mode with keccak as the PRF, so a key must never be
/// used twice; the protocol draws a fresh k per order. It gives confidentiality only
/// until k is published, which is the point: publishing k is the delivery.
///
/// What the predicate decides is narrow. It catches a key that does not open the
/// committed ciphertext to the committed bytes. It cannot judge whether those bytes are
/// what the buyer wanted; h_m only pins them, and a named data source signing h_m is the
/// protocol's way to give them meaning.
library KeyReleaseVerifier {
    /// The largest ciphertext a dispute may carry. Bounds the dispute's gas.
    uint256 internal constant MAX_CIPHERTEXT = 4096;

    error CiphertextTooLong();
    error NotTheCommittedCiphertext();
    error NotTheCommittedKey();

    /// @return fault True when the committed ciphertext does not decrypt to the
    /// committed plaintext under the published key.
    function proveFault(bytes calldata c, bytes32 key, bytes32 keyHash, bytes32 ciphertextHash, bytes32 plaintextHash)
        internal
        pure
        returns (bool fault)
    {
        require(c.length <= MAX_CIPHERTEXT, CiphertextTooLong());
        require(keccak256(abi.encodePacked(key)) == keyHash, NotTheCommittedKey());
        require(keccak256(c) == ciphertextHash, NotTheCommittedCiphertext());
        return keccak256(decrypt(c, key)) != plaintextHash;
    }

    function decrypt(bytes calldata c, bytes32 key) internal pure returns (bytes memory m) {
        m = new bytes(c.length);
        uint256 blocks = (c.length + 31) / 32;
        for (uint256 i = 0; i < blocks; i++) {
            bytes32 pad = keccak256(abi.encodePacked(key, i));
            bytes32 word;
            uint256 offset = i * 32;
            assembly {
                word := calldataload(add(c.offset, offset))
            }
            word ^= pad;
            uint256 remaining = c.length - offset;
            if (remaining >= 32) {
                assembly {
                    mstore(add(add(m, 32), offset), word)
                }
            } else {
                for (uint256 j = 0; j < remaining; j++) {
                    m[offset + j] = word[j];
                }
            }
        }
    }
}

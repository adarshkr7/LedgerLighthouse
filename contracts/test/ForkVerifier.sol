// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// Stands in for Inco's verifier on a local fork, which has no covalidators to sign
/// decisions. tools/e2e installs it over the real verifier on that fork and nowhere else.
///
/// An attestation here is the ABI encoding of what it attests, so it is bound to one
/// handle and one value just as a real one is: replaying one on another spend, or
/// claiming the opposite value, still fails. It proves nothing about who decided.
///
/// Everything else runs the original verifier's code against this address's storage,
/// because Inco's SDK reads the network's public key from here.
contract ForkVerifier {
    struct DecryptionAttestation {
        bytes32 handle;
        bytes32 value;
    }

    address private immutable ORIGINAL_CODE;

    constructor(address originalCode) {
        ORIGINAL_CODE = originalCode;
    }

    function isValidDecryptionAttestation(DecryptionAttestation memory attestation, bytes[] memory signatures)
        external
        pure
        returns (bool)
    {
        return signatures.length == 1
            && keccak256(signatures[0]) == keccak256(abi.encode(attestation.handle, attestation.value));
    }

    fallback() external payable {
        address target = ORIGINAL_CODE;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), target, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    receive() external payable {}
}

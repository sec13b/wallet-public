import { ethers } from "ethers";
import { bip44Scheme } from "../../btc/lib/addresses-schemes";
import { improveAndRethrow } from "../../../common/utils/errorUtils";
import { getAccountsData, getCurrentNetwork } from "../../../common/services/internal/storage";
import { Coins } from "../../coins";
import { getDecryptedWalletCredentials } from "../../../auth/services/authService";
import { EthKeys } from "../lib/ethKeys";

export class EthAddressesService {
    /**
     * Retrieves ethereum address for current wallet. Derivation path: m/44'/60'/0'/0/0
     *
     * @returns {string} ethereum address
     */
    static getCurrentEthAddress() {
        try {
            const ethNetwork = getCurrentNetwork(Coins.COINS.ETH);
            const accountsData = getAccountsData();
            const accountData = accountsData.getAccountData(bip44Scheme, ethNetwork, 0);
            const publicKey = EthKeys.generateAddressPublicKeyByAccountPublicKey(accountData);

            return ethers.utils.computeAddress(publicKey).toLowerCase();
        } catch (e) {
            improveAndRethrow(e, "getCurrentEthAddress");
        }
    }

    /**
     * Calculates address and private key for current ether wallet default derivation path
     *
     * @param password {string} password of current wallet
     * @return {[{privateKey: string, address: string}]}
     */
    static exportAddressesWithPrivateKeys(password) {
        try {
            const ethNetwork = getCurrentNetwork(Coins.COINS.ETH);
            const { mnemonic, passphrase } = getDecryptedWalletCredentials(password);
            const { publicKey, privateKey } = EthKeys.generateKeysForAccountAddressByWalletCredentials(
                mnemonic,
                passphrase,
                ethNetwork
            );

            const address = ethers.utils.computeAddress(publicKey).toLowerCase();

            return [{ address: address, privateKey: "0x" + privateKey.toString("hex") }];
        } catch (e) {
            improveAndRethrow(e, "exportAddressesWithPrivateKeys");
        }
    }
}

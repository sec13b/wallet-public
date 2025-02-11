import bip39 from "bip39";
import secureRandom from "secure-random";
import Cookie from "js-cookie";

import { Logger } from "../../support/services/internal/logs/logger";
import { decrypt, encrypt, getHash } from "../../common/adapters/crypto-utils";
import {
    clearAccountsData,
    clearDataPassword,
    clearStorage,
    getEncryptedWalletCredentials,
    getIsPassphraseUsed,
    getWalletId,
    saveAccountsData,
    saveDataPassword,
    saveEncryptedWalletCredentials,
    saveIsPassphraseUsed,
    saveWalletId,
} from "../../common/services/internal/storage";
import { improveAndRethrow } from "../../common/utils/errorUtils";
import { SupportedSchemes } from "../../wallet/btc/lib/addresses-schemes";
import { AccountsData } from "../../wallet/btc/lib/accounts";
import {
    authenticateAndCreateSession,
    changePasswordHash,
    deleteWallet,
    isCurrentClientSessionValidOnServer,
    isPassphraseHashCorrespondToWallet,
    isPasswordHashCorrespondToWallet,
    logoutWallet,
    saveWalletOnServerAndCreateSession,
} from "../backend-api/walletsApi";
import { ApiCallWrongResponseError } from "../../common/backend-api/utils";
import AddressesService from "../../wallet/btc/services/addressesService";
import ClientIpHashService from "./internal/clientIpHashService";
import {
    AUTHENTICATION_DISCOVERED_EVENT,
    EventBus,
    LOGGED_OUT_EVENT,
    SIGNED_IN_EVENT,
    SIGNED_UP_EVENT,
    WALLET_DELETED_EVENT,
    WALLET_IMPORTED_EVENT,
} from "../../common/adapters/eventbus";
import { WalletDataApi } from "../../wallet/common/backend-api/walletDataApi";
import { ImportWalletService } from "../../wallet/btc/services/importWalletService";
import { Coins } from "../../wallet/coins";

export const ALLOWED_MNEMONIC_LENGTHS = [12, 15, 18, 21, 24];

const WORDS_LISTS = [
    bip39.wordlists.english,
    bip39.wordlists.chinese_simplified,
    bip39.wordlists.japanese,
    bip39.wordlists.korean,
    bip39.wordlists.chinese_traditional,
    bip39.wordlists.french,
    bip39.wordlists.spanish,
    bip39.wordlists.italian,
];

/**
 * Checks whether are there saved wallet data. This method is useful to e.g. decide which login step to show.
 *
 * @return Boolean - true if there is saved wallet data and false otherwise
 */
// TODO: [tests, low] Unit tests are required
export function isWalletDataPresent() {
    const loggerSource = "isWalletDataPresent";
    try {
        const encryptedWalletCredentials = getEncryptedWalletCredentials();

        const isPresent = !!(
            encryptedWalletCredentials != null &&
            encryptedWalletCredentials.encryptedMnemonic &&
            encryptedWalletCredentials.encryptedPassphrase
        );

        Logger.log(`Checking wallet data presence: ${isPresent}`, loggerSource);

        return isPresent;
    } catch (e) {
        improveAndRethrow(e, loggerSource);
    }
}

/**
 * Validates given mnemonic phrase.
 *
 * @param mnemonic - phrase to be validated
 * @param allowedLengths - optional parameter to use only specific word counts for phrase validation
 * @returns Object { result: true } or { result: false, errorDescription: string, howToFix: string }
 */
export function validateMnemonic(mnemonic, allowedLengths = ALLOWED_MNEMONIC_LENGTHS) {
    const howToFixMessage = `Secret words should be a string of lowercase words separated with a single space. Allowed word quantities: ${allowedLengths.join(
        ", "
    )}. `;
    if (!mnemonic || typeof mnemonic !== "string") {
        return {
            errorDescription:
                "That’s pretty secret... but we need secret words to exist in order to keep your wallet secure. ",
            howToFix: howToFixMessage,
            result: false,
        };
    }

    const singleSpaceSeparatedMnemonic = mnemonic.replace(/ +/g, " ").trim();
    const words = singleSpaceSeparatedMnemonic.split(" ");
    const isLengthCorrect = allowedLengths.filter(len => len === words.length).length;
    if (!isLengthCorrect) {
        return {
            errorDescription: `Not supported words count: ${words.length}. `,
            howToFix: howToFixMessage,
            result: false,
        };
    }

    let isMnemonicValid = false;
    for (let wordsList of WORDS_LISTS) {
        if (bip39.validateMnemonic(singleSpaceSeparatedMnemonic, wordsList)) {
            isMnemonicValid = true;
            break;
        }
    }

    if (!isMnemonicValid) {
        return {
            errorDescription: `The entered secret words are not valid. `,
            howToFix:
                "We support word lists from the following languages: " +
                "English, Chinese (Traditional), Chinese (Simplified), French, Italian, Japanese, Korean, and Spanish." +
                "Check out this page (https://github.com/bitcoin/bips/blob/master/bip-0039/bip-0039-wordlists.md) for more details. ",
            result: false,
        };
    }

    return { result: true };
}

/**
 * Generates new random mnemonic phrase (currently only of 12 words length)
 *
 * @return {string} 12 words lower case separated with single space
 */
export function createNewMnemonic() {
    try {
        // TODO: [feature, moderate] Support other words counts (currently buf size is for 12 words)
        const entropyForMnemonic = secureRandom.randomBuffer(16).toString("hex");
        return bip39.entropyToMnemonic(entropyForMnemonic);
    } catch (e) {
        improveAndRethrow(e, "createNewMnemonic");
    }
}

/**
 * For first step of authentication flow. Just checks whether passphrase is ok for correct wallet.
 *
 * @param mnemonic - mnemonic phrase to check
 * @param passphrase - passphrase phrase to check
 * @returns Promise resolving to:
 *         "passphrase_correct" if wallet exists and passphrase correct
 *         "passphrase_not_correct" if wallet exist and passphrase is not correct
 *         "wallet_not_exist" if wallet doesn't exist
 */
export async function isPassphraseCorrect(mnemonic, passphrase) {
    try {
        const result = await isPassphraseHashCorrespondToWallet(mnemonicToWalletId(mnemonic), getHash(passphrase));

        Logger.log(`Checking passphrase result: ${JSON.stringify(result)}`, "isPassphraseCorrect");

        return (
            (result.reason === "walletId" && "wallet_not_exist") ||
            (result.reason === "passphrase" && "passphrase_not_correct") ||
            "passphrase_correct"
        );
    } catch (e) {
        improveAndRethrow(e, "isPassphraseCorrect");
    }
}

/**
 * Prepares data for loginIntoWalletAndCreateSession.
 *
 * Adds one more result representing case when there is no saved credentials.
 */
export async function loginIntoWalletBySavedMnemonicAndCreateSession(password) {
    const encryptedWalletCredentials = getEncryptedWalletCredentials();

    if (encryptedWalletCredentials != null) {
        let mnemonic = "";
        let passphrase = "";
        try {
            mnemonic = decrypt(encryptedWalletCredentials.encryptedMnemonic, password);
            passphrase = decrypt(encryptedWalletCredentials.encryptedPassphrase, password);
        } catch (e) {
            Logger.log("Decryption of mnemonic or passphrase failed", "loginIntoWalletBySavedMnemonicAndCreateSession");
            // Decryption can fail in case of wrong password so we processing it and passing
            // empty mnemonic to login call as it will fail and update login attempts counter on server
            mnemonic = "";
        }

        return loginIntoWalletAndCreateSession(mnemonic, passphrase, password, getWalletId());
    }

    return {
        result: false,
        reason: "no_saved_data",
    };
}

/**
 * See docs for loginIntoWalletAndCreateSession
 */
export async function loginIntoWalletByMnemonicAndCreateSession(mnemonic, password, passphrase = "") {
    return loginIntoWalletAndCreateSession(mnemonic, passphrase, password);
}

/**
 * Performs login into existing wallet by given mnemonic and password.
 * If login succeeds saves accounts data of this wallet, encrypted mnemonic and walletId to storage for further use.
 *
 * Returning promise is resolved to one of objects:
 *   1. { result: false, reason: "walletId" }
 *      - wallet id was not found
 *   2. { result: false, reason: "locked", millisecondsToWaitForUnlocking: number milliseconds }
 *      - wallet has been locked due to lots of failed login attempts, use millisecondsToWaitForUnlocking to know waiting period
 *   3. { result: false, reason: "password", attemptsRemained: positive integer number }
 *      - password is wrong, you have only returned number of login attempts before lock of wallet
 *   4. { result: false, reason: "password", lockPeriodMs: number milliseconds }
 *      - you have lost your last attempt to login due to wrong password, wait lockPeriodMs and try again
 *   5. { result: false, reason: "forbidden_ip" }
 *      - client's ip is not whitelisted
 *   6. { result: true, sessionId: string }
 *      - successful login
 *   7. { result: false, reason: "passphrase" }
 *      - failed to login due to wrong passphrase
 */
async function loginIntoWalletAndCreateSession(mnemonic, passphrase, password, walletId) {
    const loggerSource = "loginIntoWalletAndCreateSession";
    try {
        const passphraseHash = getHash(passphrase);
        const passwordHash = getHash(password);
        if (!walletId) {
            walletId = mnemonicToWalletId(mnemonic);
        }

        const ipHash = await ClientIpHashService.calculateIpHash(mnemonicToDataPassword(mnemonic));
        const authResult = await authenticateAndCreateSession(walletId, passphraseHash, passwordHash, ipHash);

        Logger.log(`Authentication result ${JSON.stringify(authResult)}`, loggerSource);

        const accountsData = new AccountsData(mnemonic, passphrase, SupportedSchemes, Coins.getSupportedNetworks());
        saveAccountsData(accountsData);
        saveEncryptedWalletCredentials(encrypt(mnemonic, password), encrypt(passphrase, password));
        saveWalletId(mnemonicToWalletId(mnemonic));
        saveDataPassword(mnemonicToDataPassword(mnemonic));
        isJustLoggedOutFlag = false;
        resetIntervalLookingForAuthentication();
        await ClientIpHashService.provideIpHashStored();

        EventBus.dispatch(SIGNED_IN_EVENT);

        return authResult;
    } catch (e) {
        if (e instanceof ApiCallWrongResponseError && e.isForbiddenError()) {
            const error = e.authenticationError || e.authorizationError;
            Logger.log(`Authentication error ${JSON.stringify(error)}`, loggerSource);
            return error;
        }

        improveAndRethrow(e, loggerSource);
    }
}

export function mnemonicToWalletId(mnemonic) {
    return getHash(mnemonic);
}

/**
 * This password is used to encrypt wallet data like credentials and IP address, transaction details
 *
 * @param mnemonic - mnemonic is a base for hashing to get the password
 * @return {string} data password
 */
export function mnemonicToDataPassword(mnemonic) {
    // Making some string based on mnemonic to get different hash than just from mnemonic
    const mnemonicBasedString = mnemonic
        .split(" ")
        .slice(2, 10)
        .join(" ");
    return getHash(mnemonicBasedString);
}

/**
 * Performs import of wallet by given mnemonic and password.
 * Note that we cannot check password here as each password for given mnemonic produces valid Bitcoin Wallet in terms
 * of bip39 specification.
 *
 * @param mnemonic - mnemonic phrase of importing wallet
 * @param password - password of importing wallet
 * @param passphrase - passphrase for mnemonic, empty string by default
 * @returns Promise resolving to object { result: true } or { result: false, errorDescription: string, howToFix: string }
 *          (in case of error - wallet already exists)
 */
export async function importWalletByMnemonic(mnemonic, password, passphrase = "") {
    const loggerSource = "importWalletByMnemonic";
    try {
        Logger.log(`Start importing a wallet. Password/passphrase is empty:${!!password}${!!passphrase}`, loggerSource);

        const accountsDataResult = await saveNewWalletAndProvideLocalData(mnemonic, passphrase, password);
        if (accountsDataResult.errorDescription) {
            Logger.log("Failed to save new wallet during the import", loggerSource);
            return accountsDataResult;
        }

        Logger.log("New wallet successfully saved during the import", loggerSource);

        await ImportWalletService.grabWalletHistoricalDataAndSave();

        EventBus.dispatch(WALLET_IMPORTED_EVENT);

        Logger.log("Wallet imported event was successfully sent during the import", loggerSource);

        return { result: true };
    } catch (e) {
        improveAndRethrow(e, loggerSource);
    }
}

/**
 * Saves new wallet on server, creates session there and set flag to scan addresses later.
 *
 * @param mnemonic - phrase of new wallet
 * @param password - password string of new wallet
 * @param passphrase - passphrase for mnemonic
 * @returns Promise resolving to { result: true } or { result: false, errorDescription: string, howToFix: string }
 *          (in case of error - wallet already exists)
 */
export async function saveNewWalletByMnemonicOnServerAndCreateSession(mnemonic, password, passphrase = "") {
    const loggerSource = "saveNewWalletByMnemonicOnServerAndCreateSession";
    try {
        Logger.log("Start saving new wallet on server", loggerSource);

        const result = await saveNewWalletAndProvideLocalData(mnemonic, passphrase, password);
        if (result.errorDescription) {
            Logger.log(`Failed to save new wallet on server ${JSON.stringify(result)}`, loggerSource);

            return result;
        }

        Logger.log("New wallet saved on server, returning true", loggerSource);
        return { result: true };
    } catch (e) {
        improveAndRethrow(e, loggerSource);
    }
}

async function saveNewWalletAndProvideLocalData(mnemonic, passphrase = "", password) {
    const loggerSource = "saveNewWalletAndProvideLocalData";
    try {
        Logger.log("Start saving", loggerSource);

        const passwordHash = getHash(password);
        const passphraseHash = getHash(passphrase);
        const accountsData = new AccountsData(mnemonic, passphrase, SupportedSchemes, Coins.getSupportedNetworks());
        const dataPassword = mnemonicToDataPassword(mnemonic);
        const { initialIndexesData, initialAddressesData } = AddressesService.createInitialAddressesData(
            accountsData,
            dataPassword
        );

        await saveWalletOnServerAndCreateSession(
            mnemonicToWalletId(mnemonic),
            passphraseHash,
            passwordHash,
            initialIndexesData,
            initialAddressesData
        );

        Logger.log("Wallet saved", loggerSource);

        saveAccountsData(accountsData);
        saveEncryptedWalletCredentials(encrypt(mnemonic, password), encrypt(passphrase, password));
        saveWalletId(mnemonicToWalletId(mnemonic));
        saveDataPassword(dataPassword);
        saveIsPassphraseUsed(mnemonicToWalletId(mnemonic), !!passphrase);
        isJustLoggedOutFlag = false; // TODO: [refactoring, low] Move to mediators
        resetIntervalLookingForAuthentication();
        await ClientIpHashService.provideIpHashStored(); // TODO: [refactoring, low] Move to mediators

        Logger.log("IP hash provided", loggerSource);

        EventBus.dispatch(SIGNED_UP_EVENT);

        return accountsData;
    } catch (e) {
        if (e instanceof ApiCallWrongResponseError && e.isWalletExistError()) {
            return {
                result: false,
                errorDescription: e.serverErrorDescription,
                howToFix: e.serverHowToFix,
            };
        }

        improveAndRethrow(e, loggerSource);
    }
}

/**
 * Removes current session and local wallet data
 *
 * @returns Promise resolving to void
 */
export async function doLogout() {
    const loggerSource = "doLogout";
    try {
        Logger.log("Start logging out", loggerSource);

        await logoutWallet(getWalletId());

        Logger.log("Successfully logged out", loggerSource);

        // We are not clearing encrypted wallet data here as it is required for login process
        clearAccountsData();
        clearDataPassword();
        setIntervalLookingForAuthentication();
        EventBus.dispatch(LOGGED_OUT_EVENT);
        isJustLoggedOutFlag = true;
    } catch (e) {
        improveAndRethrow(e, loggerSource);
    }
}

/**
 * Removes wallet by current session (by cookies data) and clears related data from the storage.
 *
 * @returns Promise resolving to Object { result: true } if wallet removed successfully or to { result: false } if the password is wrong
 */
export async function deleteWalletByCurrentSession(password) {
    const loggerSource = "deleteWalletByCurrentSession";
    try {
        Logger.log(`Start deleting wallet, password is empty: ${!!password}`, loggerSource);

        const result = await deleteWallet(getWalletId(), getHash(password));
        if (result.result) {
            Logger.log("Wallet was removed", loggerSource);

            clearStorage();
            isJustLoggedOutFlag = true;
            EventBus.dispatch(WALLET_DELETED_EVENT);
            EventBus.dispatch(LOGGED_OUT_EVENT);
            await ClientIpHashService.provideIpHashStoredAndItsUpdate();
            Logger.log("IP hash was provided, local data were corrected", loggerSource);
        }

        Logger.log("Wallet removal was finished", loggerSource);
        return result;
    } catch (e) {
        improveAndRethrow(e, loggerSource);
    }
}

/**
 * Checks client session presence
 *
 * This method is not aimed to check current session is present on server.
 * It is just for quick check on client (e.g. to decide what page to open - for logged user or for not logged).
 * We are ok to return session here when the same time it is for example expired on server as there will be some data
 * retrieval for each page and server session check will fail and we will redirect user to some home page to login first.
 *
 * @return Boolean - true if there is client session data and false otherwise
 */
export function isThereClientSession() {
    try {
        return (Cookie.get("sessionId") && true) || false;
    } catch (e) {
        improveAndRethrow(e, "isThereClientSession");
    }
}

/**
 * Checks current client session validity on server.
 *
 * @return Promise resolving to true if session is valid and to false otherwise
 */
export async function isCurrentSessionValid() {
    try {
        const result = await isCurrentClientSessionValidOnServer(getWalletId());
        !result && setIntervalLookingForAuthentication();

        return result;
    } catch (e) {
        improveAndRethrow(e, "isCurrentSessionValid");
    }
}

/**
 * Checks whether given password is valid or not for current wallet
 *
 * @param password - the password to be checked
 * @return Promise resolving to true if the password is valid or to false otherwise
 */
export async function isPasswordValid(password) {
    try {
        Logger.log(`Checking password. The parameter is empty: ${!!password}`, "isPasswordValid");

        return await isPasswordHashCorrespondToWallet(getWalletId(), getHash(password));
    } catch (e) {
        improveAndRethrow(e, "isPasswordValid");
    }
}

/**
 * Changes the password of the wallet
 *
 * @param oldPassword - old password to check on server
 * @param newPassword - new password to be saved
 * @return Promise resolving to result Object: { result: true } if password is changed or { result: false } if old password is not valid
 */
export async function changePassword(oldPassword, newPassword) {
    const loggerSource = "changePassword";
    try {
        Logger.log(`Changing password. The old/new are empty: ${!!oldPassword}|${!!newPassword}`, loggerSource);

        const result = await changePasswordHash(getWalletId(), getHash(oldPassword), getHash(newPassword));
        if (result.result) {
            const { encryptedMnemonic, encryptedPassphrase } = getEncryptedWalletCredentials();
            const reencryptedMnemonic = encrypt(decrypt(encryptedMnemonic, oldPassword), newPassword);
            const reencryptedPassphrase = encrypt(decrypt(encryptedPassphrase, oldPassword), newPassword);
            saveEncryptedWalletCredentials(reencryptedMnemonic, reencryptedPassphrase);
        }
        Logger.log(`Password changed. Returning: ${JSON.stringify(result)}`, loggerSource);

        return result;
    } catch (e) {
        improveAndRethrow(e, loggerSource);
    }
}

/**
 * Retrieves las password change date
 *
 * @return Promise resolving to Date
 */
export async function getLastPasswordChangeDate() {
    try {
        const data = await WalletDataApi.getWalletData(getWalletId());
        if (data?.lastPasswordChangeDate) {
            return data.lastPasswordChangeDate;
        }

        throw new Error("Failed to get last password change date.");
    } catch (e) {
        improveAndRethrow(e, "getLastPasswordChangeDate");
    }
}

export let isJustLoggedOutFlag = false;

/**
 * Returns whether there were manual logout. This flag can helps to stop NO_AUTHENTICATION_EVENT processing
 *
 * @return {boolean}
 */
export function isJustLoggedOut() {
    return isJustLoggedOutFlag;
}

let checkAuthenticationIntervalId = null;
function setIntervalLookingForAuthentication() {
    checkAuthenticationIntervalId && clearInterval(checkAuthenticationIntervalId);
    checkAuthenticationIntervalId = setInterval(async () => {
        if (await isCurrentSessionValid()) {
            EventBus.dispatch(AUTHENTICATION_DISCOVERED_EVENT);
            checkAuthenticationIntervalId = null;
        }
    }, 5000);
}

function resetIntervalLookingForAuthentication() {
    checkAuthenticationIntervalId && clearInterval(checkAuthenticationIntervalId);
    checkAuthenticationIntervalId = null;
}

/**
 * Checks locally whether the passphrase is used for wallet identified by the given mnemonic
 *
 * @param mnemonic - mnemonic to check passphrase usage for
 * @return true if used, false if not used and null if no data found locally for this mnemonic
 */
export function checkLocallyIfPassphraseUsed(mnemonic) {
    try {
        return getIsPassphraseUsed(mnemonicToWalletId(mnemonic));
    } catch (e) {
        improveAndRethrow(e, "checkLocallyIfPassphraseUsed");
    }
}

/**
 * Saves locally flag that the passphrase is used for wallet identified by the given mnemonic
 *
 * @param mnemonic - mnemonic to save passphrase usage for
 */
export function saveLocallyFlagThatPassphraseIsUsed(mnemonic) {
    try {
        saveIsPassphraseUsed(mnemonicToWalletId(mnemonic), true);
    } catch (e) {
        improveAndRethrow(e, "saveLocallyFlagThatPassphraseIsUsed");
    }
}

export function getDecryptedWalletCredentials(password) {
    try {
        const encryptedWalletCredentials = getEncryptedWalletCredentials();
        return {
            mnemonic: decrypt(encryptedWalletCredentials.encryptedMnemonic, password),
            passphrase: decrypt(encryptedWalletCredentials.encryptedPassphrase, password),
        };
    } catch (e) {
        improveAndRethrow(e, "getDecryptedWalletCredentials");
    }
}

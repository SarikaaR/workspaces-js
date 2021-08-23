import * as path from 'path';
import * as os from 'os';
import * as nearAPI from 'near-api-js';
import {asId, randomAccountId, toYocto} from '../utils';
import {PublicKey, KeyPair, BN, KeyPairEd25519, FinalExecutionOutcome, KeyStore, fullAccessKey, AccessKey} from '../types';
import {debug, getKeyFromFile} from '../runtime/utils';
import {AccountBalance, NamedAccount} from '../runtime/types';
import {Transaction} from '../runtime/transaction';
import {JSONRpc} from '../provider';
import {NEAR} from '../interfaces';
import {Account} from './account';
import {NearAccount} from './near-account';
import {findCallerFile} from './utils';
import {NearAccountManager} from './near-account-manager';

async function findAccountsWithPrefix(
  prefix: string,
  keyStore: KeyStore,
  network: string,
): Promise<string[]> {
  const accounts = await keyStore.getAccounts(network);
  debug(`Looking ${prefix} in ${accounts.join('\n')}`);
  const paths = accounts.filter(f => f.startsWith(prefix));
  debug(`found [${paths.join(', ')}]`);
  if (paths.length > 0) {
    return paths;
  }

  return [`${randomAccountId(prefix, '')}`];
}

type AccountShortName = string;
type AccountId = string;

export interface Network {
  id: string;
  rpcAddr: string;
  helperUrl?: string;
}

export abstract class AccountManager implements NearAccountManager {
  accountsCreated: Map<AccountId, AccountShortName> = new Map();
  constructor(
    protected near: NEAR,
  ) {}

  static async create(
    near: NEAR,
  ): Promise<AccountManager> {
    let manager: AccountManager;
    const {network} = near.config;
    switch (network) {
      case 'sandbox':
        manager = new SandboxManager(near);
        break;
      case 'testnet':
        manager = new TestnetManager(near);
        break;
      default: throw new Error(`Bad network id: ${network as string} expected "testnet" or "sandbox"`);
    }

    return manager.init();
  }

  getAccount(accountId: string): NearAccount {
    return new Account(accountId, this);
  }

  async deleteKey(
    account_id: string,
  ): Promise<void> {
    debug(`About to delete key for ${account_id}`);
    await this.keyStore.removeKey(this.networkId, account_id);
    debug('deleted Key');
  }

  async init(): Promise<AccountManager> {
    return this;
  }

  get root(): NearAccount {
    return new Account(this.rootAccountId, this);
  }

  get initialBalance(): string {
    return this.near.config.initialBalance ?? this.DEFAULT_INITIAL_BALANCE;
  }

  get provider(): JSONRpc {
    return JSONRpc.from(this.near.config);
  }

  createTransaction(sender: NearAccount | string, receiver: NearAccount | string): Transaction {
    return new ManagedTransaction(this, sender, receiver);
  }

  async getKey(accountId: string): Promise<KeyPair | null> {
    return this.keyStore.getKey(this.networkId, accountId);
  }

  /** Sets the provider key to store, otherwise creates a new one */
  async setKey(accountId: string, keyPair?: KeyPair): Promise<KeyPair> {
    const key = keyPair ?? KeyPairEd25519.fromRandom();
    await this.keyStore.setKey(this.networkId, accountId, key);
    debug(`setting keys for ${accountId}`);
    return (await this.getKey(accountId))!;
  }

  async removeKey(accountId: string): Promise<void> {
    await this.keyStore.removeKey(this.networkId, accountId);
  }

  async deleteAccount(accountId: string, beneficiaryId: string): Promise<void> {
    await this.getAccount(accountId).delete(beneficiaryId);
  }

  async getRootKey(): Promise<KeyPair> {
    const keyPair = await this.getKey(this.rootAccountId);
    if (!keyPair) {
      return this.setKey(this.rootAccountId);
    }

    return keyPair;
  }

  async balance(account: string | NearAccount): Promise<AccountBalance> {
    return this.provider.account_balance(asId(account));
  }

  async exists(accountId: string | NearAccount): Promise<boolean> {
    return this.provider.accountExists(asId(accountId));
  }

  async executeTransaction(tx: Transaction, keyPair?: KeyPair): Promise<FinalExecutionOutcome> {
    const account: nearAPI.Account = new nearAPI.Account(this.connection, tx.senderId);
    let oldKey: KeyPair | null = null;
    if (keyPair) {
      oldKey = await this.getKey(account.accountId);
      await this.setKey(account.accountId, keyPair);
    }

    // @ts-expect-error access shouldn't be protected
    const outcome: FinalExecutionOutcome = await account.signAndSendTransaction({receiverId: tx.receiverId, actions: tx.actions});

    if (oldKey) {
      await this.setKey(account.accountId, oldKey);
    }

    return outcome;
  }

  addAccountCreated(account: string, sender: string): void {
    const short = account.replace(`.${sender}`, '');
    this.accountsCreated.set(account, short);
  }

  async cleanup(): Promise<void> {} // eslint-disable-line @typescript-eslint/no-empty-function

  get rootAccountId(): string {
    return this.near.config.rootAccount!;
  }

  // Abstract initRootAccount(): Promise<string>;
  abstract get DEFAULT_INITIAL_BALANCE(): string;
  abstract createFrom(near: NEAR): Promise<NearAccountManager>;
  abstract get defaultKeyStore(): KeyStore;

  protected get keyStore(): KeyStore {
    return this.near.config.keyStore ?? this.defaultKeyStore;
  }

  protected get signer(): nearAPI.InMemorySigner {
    return new nearAPI.InMemorySigner(this.keyStore);
  }

  protected get networkId(): string {
    return this.near.config.network;
  }

  protected get connection(): nearAPI.Connection {
    return new nearAPI.Connection(this.networkId, this.provider, this.signer);
  }
}

export class TestnetManager extends AccountManager {
  static readonly KEYSTORE_PATH: string = path.join(os.homedir(), '.near-credentials', 'near-runner');
  static readonly KEY_DIR_PATH: string = path.join(TestnetManager.KEYSTORE_PATH, 'testnet');

  static get defaultKeyStore(): KeyStore {
    const keyStore = new nearAPI.keyStores.UnencryptedFileSystemKeyStore(
      this.KEYSTORE_PATH,
    );
    return keyStore;
  }

  get DEFAULT_INITIAL_BALANCE(): string {
    return toYocto('50');
  }

  get defaultKeyStore(): KeyStore {
    return TestnetManager.defaultKeyStore;
  }

  async init(): Promise<AccountManager> {
    await this.createAndFundAccount();
    return this;
  }

  async createAccount(accountId: string, pubKey: PublicKey): Promise<NearAccount> {
    const accountCreator = new nearAPI.accountCreator.UrlAccountCreator(
      {} as any, // ignored
      this.near.config.helperUrl!,
    );
    await accountCreator.createAccount(accountId, pubKey);
    return this.getAccount(accountId);
  }

  async addFunds(): Promise<void> {
    const temporaryId = randomAccountId();
    console.log(temporaryId);
    const keyPair = await this.getRootKey();
    const {keyStore} = this;
    await keyStore.setKey(this.networkId, temporaryId, keyPair);
    const account = await this.createAccount(temporaryId, keyPair.getPublicKey());
    await account.delete(this.rootAccountId);
  }

  async createAndFundAccount(): Promise<void> {
    await this.initRootAccount();
    const accountId: string = this.rootAccountId;
    if (!(await this.provider.accountExists(accountId))) {
      const keyPair = await this.getRootKey();
      const {keyStore} = this;
      await keyStore.setKey(this.networkId, accountId, keyPair);
      await this.createAccount(accountId, keyPair.getPublicKey());
      debug(`Added masterAccount ${
        accountId
      }
          https://explorer.testnet.near.org/accounts/${this.rootAccountId}`);
    }

    if (new BN((await this.root.balance()).available).lt(new BN(toYocto('1000')))) {
      await this.addFunds();
    }
  }

  async initRootAccount(): Promise<void> {
    if (this.near.config.rootAccount) {
      return;
    }

    const fileName = findCallerFile();
    const p = path.parse(fileName);
    if (['.ts', '.js'].includes(p.ext)) {
      let {name} = p;
      if (name.includes('.')) {
        name = name.split('.')[0];
      }

      const accounts = await findAccountsWithPrefix(name, this.keyStore, this.networkId);
      const accountId = accounts.shift()!;
      await Promise.all(
        accounts.map(async acc => {
          await this.deleteAccount(acc, accountId);
        }),
      );
      this.near.config.rootAccount = accountId;
      return;
    }

    throw new Error(
      `Bad filename/account name passed: ${fileName}`,
    );
  }

  async createFrom(near: NEAR): Promise<AccountManager> {
    const config = {...near.config, rootAccount: this.rootAccountId};
    return (new TestnetSubaccountManager({...near, config})).init();
  }
}

export class TestnetSubaccountManager extends TestnetManager {
  subAccount!: string;

  get rootAccountId(): string {
    return this.subAccount;
  }

  get realRoot(): NearAccount {
    return this.getAccount(this.near.config.rootAccount!);
  }

  async init(): Promise<AccountManager> {
    const root = this.realRoot;
    this.subAccount = root.makeSubAccount(randomAccountId('', ''));
    await this.realRoot.createAccount(this.subAccount, {initialBalance: toYocto('50')});
    return this;
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      [...this.accountsCreated.keys()]
        .map(async id => this.getAccount(id).delete(this.realRoot.accountId)),
    );
  }

  get initialBalance(): string {
    return toYocto('10');
  }
}

export class SandboxManager extends AccountManager {
  async init(): Promise<AccountManager> {
    if (!await this.getKey(this.rootAccountId)) {
      await this.setKey(this.rootAccountId, await getKeyFromFile(this.keyFilePath));
    }

    return this;
  }

  async createFrom(near: NEAR): Promise<NearAccountManager> {
    return new SandboxManager(near);
  }

  get DEFAULT_INITIAL_BALANCE(): string {
    return toYocto('200');
  }

  get defaultKeyStore(): KeyStore {
    const keyStore = new nearAPI.keyStores.UnencryptedFileSystemKeyStore(
      this.near.config.homeDir,
    );
    return keyStore;
  }

  get keyFilePath(): string {
    return path.join(this.near.config.homeDir, 'validator_key.json');
  }
}

export class ManagedTransaction extends Transaction {
  private delete = false;
  constructor(private readonly manager: NearAccountManager, sender: NamedAccount | string, receiver: NamedAccount | string) {
    super(sender, receiver);
  }

  createAccount(): this {
    this.manager.addAccountCreated(this.receiverId, this.senderId);
    return super.createAccount();
  }

  deleteAccount(beneficiaryId: string): this {
    this.delete = true;
    return super.deleteAccount(beneficiaryId);
  }

  /**
   *
   * @param keyPair Temporary key to sign transaction
   * @returns
   */
  async signAndSend(keyPair?: KeyPair): Promise<FinalExecutionOutcome> {
    const executionResult = await this.manager.executeTransaction(this, keyPair);
    // @ts-expect-error status could not have SuccessValue and this would catch that
    if (executionResult.status.SuccessValue !== undefined && this.delete) {
      await this.manager.deleteKey(this.receiverId);
    }

    return executionResult;
  }
}

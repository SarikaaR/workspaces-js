import { promises as fs } from "fs";
import * as nearAPI from "near-api-js";
import { join, dirname } from "path";
import * as os from "os";
import { Account, ContractAccount } from './account'
import { SandboxServer, getHomeDir } from './server';
import { debug, toYocto } from '../utils';
import { accountCreator } from "near-api-js";

export type RunnerFn = (s: Runtime) => Promise<void>;

const DEFAULT_INITIAL_DEPOSIT = toYocto("10");

function randomAccountId(): string {
  let accountId;
  // create random number with at least 7 digits
  const randomNumber = Math.floor(Math.random() * (9999999 - 1000000) + 1000000);
  accountId = `dev-${Date.now()}-${randomNumber}`;
  return accountId;
}

async function getKeyFromFile(filePath: string, create: boolean = true): Promise<nearAPI.KeyPair> {
  try {
    const keyFile = require(filePath);
    return nearAPI.utils.KeyPair.fromString(
      keyFile.secret_key || keyFile.private_key
    );
  } catch (e) {
    if (!create) throw e;

    const keyFile = await fs.open(filePath, "w");
    const keyPair = nearAPI.utils.KeyPairEd25519.fromRandom();
    await keyFile.writeFile(JSON.stringify({
      secret_key: keyPair.toString()
    }));
    await keyFile.close();
    return keyPair;
  }
}

export interface Config {
  homeDir: string;
  port: number;
  init: boolean;
  rm: boolean;
  refDir: string | null;
  network: 'sandbox' | 'testnet';
  masterAccount?: string;
  rpcAddr: string;
  helperUrl?: string;
  explorerUrl?: string;
  initialBalance?: string;
  walletUrl?: string;
  initFn?: RunnerFn;
}

export abstract class Runtime {
  static async create(config: Partial<Config>, f?: RunnerFn): Promise<Runtime> {
    let runtime: Runtime;
    switch (config.network) {
      case 'testnet': {
        if (f) {
          debug('Skipping initialization function for testnet; will run before each `runner.run`');
        }
        return new TestnetRuntime(config)
      }
      case 'sandbox': {
        const runtime = new SandboxRuntime(config);
        if (f) {
          debug('Running initialization function to set up sandbox for all future calls to `runner.run`');
          await runtime.run(f);
        }
        return runtime;
      }
      default:
        throw new Error(
          `config.network = '${config.network}' invalid; ` +
          "must be 'testnet' or 'sandbox' (the default)"
        );
    }
  }

  abstract get defaultConfig(): Config;
  abstract get keyFilePath(): string;

  abstract afterRun(): Promise<void>;

  protected root!: Account;
  protected near!: nearAPI.Near;
  protected masterKey!: nearAPI.KeyPair;
  protected keyStore!: nearAPI.keyStores.KeyStore;

  // TODO: should probably be protected
  config: Config;

  constructor(config: Partial<Config>) {
    this.config = this.getConfig(config);
  }

  get homeDir(): string {
    return this.config.homeDir;
  }

  get init(): boolean {
    return this.config.init;
  }

  get rpcAddr(): string {
    return this.config.rpcAddr;
  }

  get network(): string {
    return this.config.network;
  }

  get masterAccount(): string {
    return this.config.masterAccount!;
  }

  async getMasterKey(): Promise<nearAPI.KeyPair> {
    return getKeyFromFile(this.keyFilePath);
  }

  private getConfig(config: Partial<Config>): Config {
    return {
      ...this.defaultConfig,
      ...config
    };
  }

  abstract getKeyStore(): Promise<nearAPI.keyStores.KeyStore>;

  // Hook that child classes can override to add functionality before `connect` call
  async beforeConnect(): Promise<void> { }

  // Hook that child classes can override to add functionality after `connect` call
  async afterConnect(): Promise<void> { }

  async connect(): Promise<void> {
    this.near = await nearAPI.connect({
      deps: {
        keyStore: this.keyStore,
      },
      keyPath: this.keyFilePath,
      networkId: this.config.network,
      nodeUrl: this.rpcAddr,
      walletUrl: this.config.walletUrl,
      masterAccount: this.config.masterAccount,
      initialBalance: this.config.initialBalance,
    });
    this.root = new Account(new nearAPI.Account(
      this.near.connection,
      this.masterAccount
    ));
  }

  async run(fn: RunnerFn): Promise<void> {
    debug('About to runtime.run with config', this.config);
    try {
      this.keyStore = await this.getKeyStore();
      debug("About to call beforeConnect")
      await this.beforeConnect();
      debug("About to call connect")
      await this.connect();
      debug("About to call afterConnect")
      await this.afterConnect();
      debug("About to call run")
      await fn(this);
    } catch (e) {
      console.error(e)
      throw e; //TODO Figure out better error handling
    } finally {
      // Do any needed teardown
      await this.afterRun();
    }
  }

  protected async addMasterAccountKey(): Promise<void> {
    await this.keyStore.setKey(
      this.config.network,
      this.masterAccount,
      await this.getMasterKey()
    );
  }

  async createAccount(name: string, keyPair?: nearAPI.utils.key_pair.KeyPair): Promise<Account> {
    const pubKey = await this.addKey(name, keyPair);
    await this.near.accountCreator.createAccount(
      name,
      pubKey
    );
    return this.getAccount(name);
  }

  async createAndDeploy(
    name: string,
    wasm: string,
  ): Promise<ContractAccount> {
    const pubKey = await this.addKey(name);
    await this.near.accountCreator.createAccount(
      name,
      pubKey
    );
    const najAccount = this.near.account(name);
    const contractData = await fs.readFile(wasm);
    const result = await najAccount.deployContract(contractData);
    debug(`deployed contract ${wasm} to account ${name} with result ${JSON.stringify(result)}`);
    return new ContractAccount(najAccount);
  }

  getRoot(): Account {
    return this.root;
  }

  getAccount(name: string): Account {
    return new Account(this.near.account(name));
  }

  getContractAccount(name: string): ContractAccount {
    return new ContractAccount(
      new nearAPI.Account(this.near.connection, name)
    );
  }

  isSandbox(): boolean {
    return this.config.network == "sandbox";
  }

  isTestnet(): boolean {
    return this.config.network == "testnet";
  }

  protected async addKey(name: string, keyPair?: nearAPI.KeyPair): Promise<nearAPI.utils.PublicKey> {
    let pubKey: nearAPI.utils.key_pair.PublicKey;
    if (keyPair) {
      const key = await nearAPI.InMemorySigner.fromKeyPair(this.network, name, keyPair);
      pubKey = await key.getPublicKey();
    } else {
      pubKey = await this.near.connection.signer.createKey(
        name,
        this.config.network
      );
    }
    return pubKey;
  }
}

export class TestnetRuntime extends Runtime {

  get defaultConfig(): Config {
    return {
      homeDir: 'ignored',
      port: 3030,
      init: true,
      rm: false,
      refDir: null,
      network: 'testnet',
      rpcAddr: 'https://rpc.testnet.near.org',
      walletUrl: "https://wallet.testnet.near.org",
      helperUrl: "https://helper.testnet.near.org",
      explorerUrl: "https://explorer.testnet.near.org",
      initialBalance: DEFAULT_INITIAL_DEPOSIT,
    }
  }

  get keyFilePath(): string {
    return join(`${os.homedir()}/.near-credentials/testnet`, `${this.masterAccount}.json`);
  }

  async getKeyStore(): Promise<nearAPI.keyStores.KeyStore> {
    const keyStore = new nearAPI.keyStores.UnencryptedFileSystemKeyStore(
      `${os.homedir()}/.near-credentials`
    );
    return keyStore;
  }

  async beforeConnect(): Promise<void> {
    await this.ensureKeyFileFolder();
    const accountCreator = new nearAPI.accountCreator.UrlAccountCreator(
      ({} as any), // ignored
      this.config.helperUrl!
    );
    if (this.config.masterAccount) {
      throw new Error('custom masterAccount not yet supported on testnet');
      // create sub-accounts of it with random IDs
      this.config.masterAccount = `${randomAccountId()}.something`
    } else {
      // create new `dev-deploy`-style account (or reuse existing)
      this.config.masterAccount = randomAccountId()
    }
    await this.addMasterAccountKey();
    await accountCreator.createAccount(
      this.masterAccount,
      (await this.getMasterKey()).getPublicKey()
    );
    debug(`Added masterAccount ${this.config.masterAccount
      } with keyStore ${this.keyStore
      } and publicKey ${await this.keyStore.getKey(
        this.config.network,
        this.masterAccount
      )
      }
      https://explorer.testnet.near.org/accounts/${this.masterAccount}`);
  }

  async afterConnect(): Promise<void> {
    if (this.config.initFn) {
      debug('About to run initFn');
      await this.config.initFn(this);
    }
  }

  // Delete any accounts created
  async afterRun(): Promise<void> {

  }

  // TODO: create temp account and track to be deleted
  async createAccount(name: string, keyPair?: nearAPI.KeyPair): Promise<Account> {
    // TODO: subaccount done twice
    const account = await super.createAccount(this.makeSubAccount(name), keyPair);
    debug(`New Account: https://explorer.testnet.near.org/accounts/${account.accountId}`);
    return account
  }

  async createAndDeploy(
    name: string,
    wasm: string,
  ): Promise<ContractAccount> {
    // TODO: dev deploy!!
    const account = await super.createAndDeploy(this.makeSubAccount(name), wasm);
    debug(`Deployed new account: https://explorer.testnet.near.org/accounts/${account.accountId}`);
    return account
  }

  getAccount(name: string): Account {
    return super.getAccount(this.makeSubAccount(name));
  }

  getContractAccount(name: string): ContractAccount {
    return super.getContractAccount(this.makeSubAccount(name));
  }

  private makeSubAccount(name: string): string {
    return `${name}.${this.masterAccount}`;
  }

  private async ensureKeyFileFolder(): Promise<void> {
    const keyFolder = dirname(this.keyFilePath);
    try {
      await fs.mkdir(keyFolder, { recursive: true })
    } catch (e) {
      // TODO: check error
    }
  }
}

class SandboxRuntime extends Runtime {
  private server!: SandboxServer;

  get defaultConfig(): Config {
    const port = SandboxServer.nextPort();
    return {
      homeDir: getHomeDir(port),
      port,
      init: true,
      rm: false,
      refDir: null,
      network: 'sandbox',
      masterAccount: 'test.near',
      rpcAddr: `http://localhost:${port}`,
      initialBalance: DEFAULT_INITIAL_DEPOSIT,
    };
  }

  get keyFilePath(): string {
    return join(this.homeDir, "validator_key.json");
  }

  async getKeyStore(): Promise<nearAPI.keyStores.KeyStore> {
    const keyStore = new nearAPI.keyStores.UnencryptedFileSystemKeyStore(
      this.homeDir
    );
    return keyStore;
  }

  get rpcAddr(): string {
    return `http://localhost:${this.config.port}`;
  }

  async beforeConnect(): Promise<void> {
    this.server = await SandboxServer.init(this.config);
    if (this.init) await this.addMasterAccountKey();
    await this.server.start();
  }

  async afterRun(): Promise<void> {
    debug("Closing server with port " + this.server.port);
    this.server.close();
  }

}
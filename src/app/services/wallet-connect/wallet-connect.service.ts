import { Injectable } from '@angular/core';
import Client, { ENGINE_RPC_OPTS, SignClient } from '@walletconnect/sign-client';
import { SignClientTypes, PairingTypes, SessionTypes, ISession } from '@walletconnect/types';
// https://github.com/WalletConnect/walletconnect-monorepo/blob/bc6f6632b7c665d868bcd59669281c1ead2dd31a/packages/utils/src/errors.ts#L10
import { ErrorResponse, formatJsonRpcResult, formatJsonRpcRequest, formatJsonRpcError, getErrorByCode, getError } from '@walletconnect/jsonrpc-utils';
import { getSdkError } from '@walletconnect/utils';
import { CONSTANTS, environment } from '../../../environments/environment';
import { SubjectService } from '../subject/subject.service';
import { OperationService } from '../operation/operation.service';
import { BcService, MessageKind } from '../bc/bc.service';
import { WalletService } from '../wallet/wallet.service';
import { Subscription } from 'rxjs';
import { UtilsService } from '../utils/utils.service';
import { isEqual } from 'lodash';

const SESSION_STORAGE_KEY = 'wc@2:client:0.3//session';
const PAIRING_STORAGE_KEY = 'wc@2:core:0.3//pairing';
const KEYCHAIN_STORAGE_KEY = 'wc@2:core:0.3//keychain';
interface Pairings {
  expanded: boolean;
  size: number;
  dapp: Record<string, DPairings>;
}
interface DPairings {
  expanded: boolean;
  p: DPairing[];
}
interface DPairing {
  name: string;
  topic: string;
  expiry: number;
}
interface Sessions {
  expanded: boolean;
  size: number;
  dapp: Record<string, DSessions>;
}
interface DSessions {
  expanded: boolean;
  s: DSession[];
}
interface DSession {
  name: string;
  address: string;
  topic: string;
  expiry: number;
}
@Injectable({
  providedIn: 'root'
})
export class WalletConnectService {
  readonly supportedMethods = ['tezos_send', 'tezos_sign', 'tezos_getAccounts'];
  readonly supportedEvents = [];
  private enableWc2: any;
  client: Client;
  initDoneAt: number;
  private subscriptions: Subscription;
  delayedPairing: any;
  sessions: Sessions = { expanded: false, size: 0, dapp: {} };
  pairings: Pairings = { expanded: false, size: 0, dapp: {} };
  display: {
    pairing: Record<string, { offset: number; expanded: boolean }>;
    session: Record<string, { offset: number; expanded: boolean }>;
    pairingsExpanded: boolean;
    sessionsExpanded: boolean;
  } = { pairing: {}, session: {}, pairingsExpanded: false, sessionsExpanded: false };
  constructor(
    private subjectService: SubjectService,
    private operationService: OperationService,
    private bcService: BcService,
    private walletService: WalletService,
    private utilsService: UtilsService
  ) {
    (async () => {
      this.subjectService.login.subscribe(() => {
        if (this.client) {
          console.log('open transport');
          this.client.core.relayer.transportOpen();
        }
      });
      this.subjectService.logout.subscribe(() => {
        if (this.client) {
          console.log('close transport');
          this.client.core.relayer.transportClose();
        }
      });
      this.initBcSubscriptions();
      this.refresh();
      window.addEventListener('storage', this.storageEventHandler);
      await this.bcService.elected;
      if (!localStorage.getItem('wc2_activated')) {
        await new Promise((resolve) => {
          this.enableWc2 = resolve;
        });
      }
      this.startClient();
    })();
  }
  storageEventHandler = (ev) => {
    if ([SESSION_STORAGE_KEY, PAIRING_STORAGE_KEY].includes(ev?.key)) {
      this.refresh();
    }
  };
  ngOnDestroy(): void {
    this.subscriptions?.unsubscribe();
    window.removeEventListener('storage', this.storageEventHandler);
  }
  private async initBcSubscriptions() {
    this.subscriptions = new Subscription();
    this.subscriptions.add(
      this.bcService.subject[MessageKind.PairingRequest].subscribe(async (pairingString) => {
        if (this.client || (await this.bcService.initAsLeader()) || this.enableWc2) {
          this.pair(pairingString);
        }
      })
    );
    this.subscriptions.add(
      this.bcService.subject[MessageKind.DeleteRequest].subscribe((topic) => {
        if (this.client) {
          this.delete(topic);
        }
      })
    );
    this.subscriptions.add(
      this.bcService.subject[MessageKind.PropagateRequest].subscribe((request) => {
        console.log('propagated request:', request.type, request);
        this.subjectService.wc2.next(request);
      })
    );
    this.subscriptions.add(
      this.bcService.subject[MessageKind.PropagateResponse].subscribe((response) => {
        if (this.client) {
          console.log('propagated response:', response);
          if (response.pairingApproved !== undefined) {
            if (response.pairingApproved) {
              this.approvePairing(response.request, response.publicKey);
            } else {
              this.rejectPairing(response.request);
            }
          } else {
            this.wcResponse(response.request, response.hash, response.success);
          }
        }
      })
    );
  }
  async startClient() {
    console.log('Starting wc2 client...');
    this.client = await this.createClient();
    this.initDoneAt = new Date().getTime();
    this.subscribeToEvents();
    if (this.delayedPairing) {
      await this.delayedPairing();
    }
    this.refresh();
  }
  async createClient() {
    const opts: SignClientTypes.Options = {
      projectId: '97f804b46f0db632c52af0556586a5f3',
      relayUrl: 'wss://relay.walletconnect.com',
      logger: 'warn', //'debug',
      metadata: {
        name: 'Kukai Wallet',
        description: 'Manage your digital assets and seamlessly connect with experiences and apps on Tezos.',
        url: 'https://wallet.kukai.app',
        icons: []
      }
    };
    return Client.init(opts);
  }
  subscribeToEvents() {
    this.client.on('session_proposal', (data) => this.proposalHandler(data));
    this.client.on('session_request', async (data) => {
      // If multiple pending messages after init, we drop all expect the most recent one
      const diffMs = new Date().getTime() - this.initDoneAt;
      if (diffMs < 1000) {
        await this.utilsService.sleep(100);
        const pending = this.client.getPendingSessionRequests();
        if (pending?.length && pending[pending.length - 1].id !== data?.id) {
          if (data?.params?.request?.method !== 'tezos_getAccounts') {
            console.log('drop old wc2 message', data);
            return;
          }
        }
      }
      this.requestHandler(data);
    });
    this.client.on('session_delete', (data) => {
      console.log('delete', data);
      this.refresh();
    });
    this.client.on('session_expire', (data) => {
      console.log('expire', data);
      this.refresh();
    });
    this.client.core.pairing.events.on('pairing_delete', (data) => {
      console.log('delete', data);
      this.refresh();
    });
    this.client.core.pairing.events.on('pairing_expire', (data) => {
      console.log('expire', data);
      this.refresh();
    });
    // this.client.core.heartbeat.events.on('heartbeat_pulse', (data) => {
    //   console.log('heartbeat', data);
    // })
    const unhandledSignClientEvents: SignClientTypes.Event[] = [
      'session_update',
      'session_extend',
      'session_ping',
      //'session_delete',
      //'session_expire',
      //'pairing_delete',
      //'session_request',
      'session_event',
      'proposal_expire'
    ];
    const unhandledPairingEvents: string[] = ['pairing_ping'];
    for (const event of unhandledSignClientEvents) {
      this.client.on(event, (data: any) => console.log(event, data));
    }
    for (const event of unhandledPairingEvents) {
      this.client.core.pairing.events.on(event, (data: any) => console.log(event, data));
    }
    /*
    session_extend: "session_extend",
    pairing_ping: "pairing_ping",
    session_expire: "session_expire",
    pairing_delete: "pairing_delete",
    pairing_expire: "pairing_expire",
    proposal_expire: "proposal_expire",
    */
  }
  async proposalHandler(data) {
    const message: any = {
      id: data.id,
      version: 0,
      type: 'permission_request',
      appMetadata: {
        name: data?.params?.proposer?.metadata?.name,
        icon: data?.params?.proposer?.metadata?.icons[0]
      },
      wcData: data
    };
    if (data.params.requiredNamespaces.tezos.chains.includes(`tezos:${CONSTANTS.NETWORK}`)) {
      message.network = { type: CONSTANTS.NETWORK };
    } else {
      console.log(data.params.requiredNamespaces.tezos.chains);
      throw new Error('wrong network');
    }
    message.scopes = { methods: data.params.requiredNamespaces.tezos.methods, events: data.params.requiredNamespaces.tezos.events };
    this.subjectService.wc2.next(message);
    this.bcService.broadcast({ kind: MessageKind.PropagateRequest, payload: message });
    console.log('proposal', data);
  }
  async approvePairing(request: any, publicKey: string) {
    if (this.client) {
      const data = request.wcData;
      const namespaces: SessionTypes.Namespaces = {};
      const address = this.operationService.pk2pkh(publicKey);
      const accounts: string[] = [`tezos:${CONSTANTS.NETWORK}:${address}`];
      const methods = data.params.requiredNamespaces?.tezos?.methods
        ?.filter((method) => this.supportedMethods.includes(method))
        .concat(data.params.optionalNamespaces?.tezos?.methods?.filter((method) => this.supportedMethods.includes(method)))
        .filter((m) => m);
      const events = data.params.requiredNamespaces?.tezos?.events
        ?.filter((event) => this.supportedEvents.includes(event))
        .concat(data.params.optionalNamespaces?.tezos?.events?.filter((event) => this.supportedEvents.includes(event)))
        .filter((e) => e);
      const sessionProperties = {
        algo: address.startsWith('tz1') ? 'ed25519' : address.startsWith('tz2') ? 'secp256k1' : 'unknown',
        address: address,
        pubkey: publicKey
      };
      namespaces.tezos = {
        accounts,
        methods,
        events
      };
      const { topic, acknowledged } = await this.client.approve({
        id: data.id,
        relayProtocol: data.params.relays[0].protocol,
        namespaces,
        sessionProperties
      });
      this.refresh();
      await acknowledged();
      //this.bcService.broadcast({ kind: MessageKind.PropagateResponse, payload: null })
      this.refresh();
    } else {
      this.bcService.broadcast({ kind: MessageKind.PropagateResponse, payload: { request, publicKey, pairingApproved: true } });
    }
  }
  async wcResponse(request: any, hash: string, success: boolean) {
    if (hash === 'silent') {
      return;
    }
    console.log('wcResponse', hash);
    if (this.client) {
      const data = request.wcData;
      // hash, operation_hash, transaction_hash??
      let msg = {};
      if (request.type === 'operation_request') {
        // this is not a transaction hash, but need this property name to get it working with Beacon
        msg = { transactionHash: hash };
      } else if (request.type === 'sign_payload_request') {
        msg = { signature: hash };
      } else {
        throw new Error('Unknown request type');
      }
      const result = formatJsonRpcResult(data.id, msg);
      const error = formatJsonRpcError(data.id, getSdkError('USER_REJECTED').message);
      await this.client.respond({
        topic: data.topic,
        response: success ? result : error
      });
    } else {
      // if not silent
      this.bcService.broadcast({ kind: MessageKind.PropagateResponse, payload: { request, hash, success } });
    }
  }
  async rejectPairing(request: any) {
    const data = request.wcData;
    if (this.client) {
      await this.client.reject({
        id: data.id,
        reason: getSdkError('USER_REJECTED')
      });
    } else {
      this.bcService.broadcast({ kind: MessageKind.PropagateResponse, payload: { request, pairingApproved: false } });
    }
  }
  private async requestHandler(data: any) {
    if (!this.walletService.wallet) {
      const error = formatJsonRpcError(data.id, getSdkError('USER_REJECTED').message);
      await this.client.respond({
        topic: data.topic,
        response: error
      });
    }
    console.log('requestHandler', data);
    const session = this.client.session.get(data.topic);
    const allowedAccounts = session?.namespaces?.tezos?.accounts || [];
    const allowedMethods = session.namespaces.tezos.methods || [];
    const account = `${data.params.chainId}:${data.params.request.params.account}`;
    const method = data.params.request.method;
    if (!allowedMethods.includes(method)) {
      throw new Error(`Method not allowed: ${method}`);
    }
    if (!allowedAccounts.includes(account) && !['tezos_getAccounts'].includes(method)) {
      throw new Error(`Account not allowed: ${account}`);
    }
    switch (method) {
      case 'tezos_send':
        const send_req = {
          type: 'operation_request',
          version: 0,
          sourceAddress: data.params.request.params.account,
          operationDetails: data.params.request.params.operations,
          network: { type: data.params.chainId.split(':')[1] },
          wcData: data
        };
        this.subjectService.wc2.next(send_req);
        this.bcService.broadcast({ kind: MessageKind.PropagateRequest, payload: send_req });
        break;
      case 'tezos_sign':
        const sign_req = {
          type: 'sign_payload_request',
          version: 0,
          sourceAddress: data.params.request.params.account,
          signingType: 'raw',
          payload: data.params.request.params.payload,
          wcData: data
        };
        this.subjectService.wc2.next(sign_req);
        this.bcService.broadcast({ kind: MessageKind.PropagateRequest, payload: sign_req });
        break;
      case 'tezos_getAccounts':
        try {
          const session = this.client.session.get(data.topic);
          const accounts: { algo: string; address: string; pubkey: string }[] = session.namespaces.tezos.accounts.map((account) => {
            const address: string = account.split(':')[2];
            const impAcc = this.walletService.wallet.getImplicitAccount(address);
            if (!impAcc) {
              throw new Error('User is not logged in with the requested account');
            }
            const algo: string = address.startsWith('tz1') ? 'ed25519' : address.startsWith('tz2') ? 'secp256k1' : 'unknown';
            const pubkey = impAcc.pk;
            return { algo, address, pubkey };
          });
          await this.client.respond({
            topic: data.topic,
            response: formatJsonRpcResult(data.id, accounts)
          });
        } catch (e) {
          console.error(e.message);
          const error = formatJsonRpcError(data.id, getSdkError('USER_REJECTED').message);
          await this.client.respond({
            topic: data.topic,
            response: error
          });
        }
        break;
      default:
        console.warn('Unhandled request');
    }
    this.client.extend({ topic: data.topic });
    this.refresh();
  }
  async pair(pairingString: string) {
    if (!this.client) {
      const initAsLeader = await this.bcService.initAsLeader();
      if (!initAsLeader && !this.enableWc2) {
        console.log('broadcast pairing string =>');
        this.bcService.broadcast({ kind: MessageKind.PairingRequest, payload: pairingString });
        return;
      } else {
        if (!localStorage.getItem('wc2_activated')) {
          localStorage.setItem('wc2_activated', JSON.stringify(true));
        }
        if (this.enableWc2) {
          this.enableWc2();
        }
      }
      await new Promise((resolve, reject) => {
        this.delayedPairing = resolve;
      });
    }
    console.log('Start pairing...');
    const paired = await this.client.pair({ uri: pairingString });
    console.log('paired', paired);
  }
  refresh(n = 0) {
    const lsS = localStorage.getItem(SESSION_STORAGE_KEY);
    const lsP = localStorage.getItem(PAIRING_STORAGE_KEY);
    const _session = this.client ? this.client?.session?.getAll() : lsS ? JSON.parse(lsS) : [];
    const _pairing = this.client ? this.client?.core?.pairing?.getPairings() : lsP ? JSON.parse(lsP) : [];

    const sessionsList: DSession[] = _session
      .map((session) => {
        let inKeychain = false; // We should not need this check. But seem to be a bit buggy otherwise
        if (this.client) {
          inKeychain = this.client.core.crypto.keychain.has(session?.topic);
        } else {
          const kc = localStorage.getItem(KEYCHAIN_STORAGE_KEY);
          inKeychain = !kc ? false : !!JSON.parse(kc)[session?.topic];
        }
        if (session?.acknowledged && inKeychain) {
          const accountAddress = session?.namespaces?.tezos?.accounts[0].split(':')[2];
          return { name: session?.peer?.metadata?.name, address: accountAddress, topic: session.topic, expiry: session.expiry };
        }
      })
      .filter((s) => s);
    const _sessions: Sessions = { expanded: this.sessions.expanded, size: sessionsList.length, dapp: {} };
    for (const dSession of sessionsList) {
      if (_sessions.dapp[dSession['name']]) {
        _sessions.dapp[dSession['name']].s.push(dSession);
      } else {
        const expanded = this.sessions.dapp[dSession['name']]?.expanded ?? false;
        _sessions.dapp[dSession['name']] = { expanded, s: [dSession] };
      }
    }
    const pairingsList: DPairing[] = _pairing
      .map((pairing) => {
        let inKeychain;
        if (this.client) {
          inKeychain = this.client.core.crypto.keychain.has(pairing?.topic);
        } else {
          const kc = localStorage.getItem(KEYCHAIN_STORAGE_KEY);
          inKeychain = !kc ? false : !!JSON.parse(kc)[pairing?.topic];
        }
        if (pairing.active && inKeychain) {
          return { name: pairing?.peerMetadata?.name, topic: pairing.topic, expiry: pairing.expiry };
        }
      })
      .filter((p) => p);
    const _pairings: Pairings = { expanded: this.pairings.expanded, size: pairingsList.length, dapp: {} };
    for (const dPairing of pairingsList) {
      if (_pairings.dapp[dPairing['name']]) {
        _pairings.dapp[dPairing['name']].p.push(dPairing);
      } else {
        const expanded = this.pairings.dapp[dPairing['name']]?.expanded ?? false;
        _pairings.dapp[dPairing['name']] = { expanded, p: [dPairing] };
      }
    }
    if (!isEqual(this.pairings, _pairings)) {
      this.pairings = _pairings;
      console.log('pairings', _pairings);
    }
    if (!isEqual(this.sessions, _sessions)) {
      this.sessions = _sessions;
      console.log('sessions', _sessions);
    }
    if (++n < 5) {
      setTimeout(() => {
        this.refresh(n);
      }, n ** 2 * 100);
    }
  }
  public async updateSession(topic: string, newAddress: string) {
    const session = this.client.session.get(topic);
    let namespaces = session.namespaces;
    let acc = namespaces.tezos.accounts[0].split(':');
    acc[2] = newAddress;
    namespaces.tezos.accounts[0] = acc.join(':');
    const { acknowledged } = await this.client.update({ topic, namespaces });
    this.refresh();
    await acknowledged();
    console.log('session update acknowledged');
  }
  public async deleteSession(topic: string) {
    await this.delete(topic);
  }
  public async deletePairing(topic: string) {
    await this.delete(topic);
  }
  public async delete(topic: string) {
    try {
      if (this.client) {
        await this.disconnect(topic);
      } else {
        this.bcService.broadcast({ kind: MessageKind.DeleteRequest, payload: topic });
      }
    } catch (e) {
      console.error(e);
      this.refresh();
    }
  }
  public async deletePairings(pairings) {
    for (const pairing of pairings) {
      try {
        await this.deletePairing(pairing.topic);
      } catch (e) {
        console.error(e);
      }
    }
    this.refresh();
  }
  public async deleteSessions(sessions) {
    for (const session of sessions) {
      try {
        await this.deleteSession(session.topic);
      } catch (e) {
        console.error(e);
      }
    }
    this.refresh();
  }
  private async disconnect(topic: string) {
    console.log('delete', topic);
    try {
      await this.client.disconnect({
        topic,
        reason: getSdkError('USER_DISCONNECTED')
      });
    } catch (e) {
      console.error(e);
      console.log(this.pairings, this.sessions);
    }
    this.refresh();
  }
  private async stopClient() {
    //https://github.com/WalletConnect/walletconnect-monorepo/blob/v2.0/packages/sign-client/test/shared/helpers.ts#L4
    this.client?.core?.heartbeat?.stop();
    await this.removeListeners();
  }
  private async removeListeners(path = []) {
    const isObject = (val) => val && typeof val === 'object' && !Array.isArray(val);
    let obj: any = this.client;
    path.forEach((prop) => {
      obj = obj[prop];
    });
    if (isObject(obj)) {
      if (obj?.events?.eventNames()?.length) {
        for (const key of obj.events.eventNames()) {
          await obj.events.removeAllListeners(key as any);
        }
      }
      Object.keys(obj).forEach((key: string) => {
        if (!path.includes(key)) {
          this.removeListeners([...path, key]);
        }
      });
    }
  }
}

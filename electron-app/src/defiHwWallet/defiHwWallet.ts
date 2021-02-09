// import TransportHid from '@ledgerhq/hw-transport-node-hid';
import { getDevices } from '@ledgerhq/hw-transport-node-hid-noevents';
import { identifyUSBProductId } from '@ledgerhq/devices';
import TransportHid from '@ledgerhq/hw-transport-node-speculos';
// @ts-ignore
import { encoding, crypto, PublicKey } from 'bitcore-lib-dfi';
// import TransportBle from "@ledgerhq/hw-transport-node-ble";
import { getAltStatusMessage, StatusCodes } from '@ledgerhq/hw-transport';
import usb from 'usb';
import { LedgerDevice } from '../types/ledger';
import * as log from '../services/electronLogger';
import { DETACH_DEVICE_LEDGER } from '../constants';

const CLA = 0xe0;

// const INS_EXIT = 0xff;
const INS_GET_VERSION = 0x01;
const INS_GET_PUBKEY = 0x02;
const INS_SIGN_MSG = 0x04;
const INS_VERIFY_MSG = 0x08;
const INS_GET_IDXS_BACKUP = 0x20;
// not implemented yet
// INS_GET_TXN_HASH = 0x10;

// Get pubkey params
// const GET_PUBKEY_P1_NO_DISPLAY = 0x00;
const GET_PUBKEY_P1_DISPLAY_ADDRESS = 0x01;
// const GET_PUBKEY_P1_DISPLAY_PUBKEY = 0x02;
// const GET_PUBKEY_P1_DISPLAY_BOTH = 0x03;

/**
 * address format is one of legacy | p2sh | bech32 | cashaddr
 */
export type AddressFormat = 'legacy' | 'p2sh' | 'bech32' | 'cashaddr';

const GET_PUBKEY_P2_LEGACY = 0x00;
const GET_PUBKEY_P2_SEGWIT = 0x01;
const GET_PUBKEY_P2_NATIVE_SEGWIT = 0x02;
const GET_PUBKEY_P2_CASHADDR = 0x03;

const MAX_LENGTH_MESSAGE_SIGN = 252;

const UNCOMPRESSED_CONTROL_BYTE = 0x04;

function addressFormatToP2(format: AddressFormat): number {
  switch (format) {
    case 'legacy':
      return GET_PUBKEY_P2_LEGACY;
    case 'p2sh':
      return GET_PUBKEY_P2_SEGWIT;
    case 'bech32':
      return GET_PUBKEY_P2_NATIVE_SEGWIT;
    case 'cashaddr':
      return GET_PUBKEY_P2_CASHADDR;
  }
}

// Sign/Verify params
const SIGN_VERIFY_P1_NEED_HASH = 0x00;
const SIGN_VERIFY_P1_ALREADY_HASHED = 0x01;
/*
  P2 is a bitmask
  1st bit:
      if set - expect more apdus,
      else - last apdu.
  2nd bit:
      if set - first apdu with 4bytes key index,
      else - data contain only msg data
*/
const SIGN_VERIFY_P2_LAST = 0x00;
const SIGN_VERIFY_P2_MORE = 0x01;
const SIGN_VERIFY_P2_FIRST = 0x02;

function checkStatusCode(response: Buffer): { code: number; status: string } {
  let status: string;
  const code: number =
    (response[response.length - 2] << 8) |
    (response[response.length - 1] & 0xff);
  if (code !== StatusCodes.OK) status = getAltStatusMessage(code);
  else status = 'Ok';
  return { code, status };
}

export default class DefiHwWallet {
  transport: any;
  connected: boolean;
  devices: LedgerDevice[];

  async getDevices(): Promise<LedgerDevice[]> {
    try {
      if (!(await TransportHid.isSupported())) {
        throw new Error('Transport not supported');
      }
      const devices = [{ productId: 'sdfdf' }];
      if (devices.length === 0) {
        throw new Error('No devices connected');
      }
      // @ts-ignore
      this.devices = devices.map((device) => ({
        ...device,
        deviceModel: 'Ledger',
      }));
      return this.devices;
    } catch (err) {
      log.error(`Get devices of error: ${err.message}`);
      return Promise.reject(err);
    }
  }

  async connect(path?: string) {
    try {
      if (!(await TransportHid.isSupported())) {
        throw new Error('Transport not supported');
      }
      // TODO After develop, is will change of connect on hw-transport-node-hid
      // this.transport = await TransportHid.open(path !== undefined ? path : '');
      this.transport = await TransportHid.open({ apduPort: 40000 });
      this.connected = true;
      log.info('Ledger is connected');
    } catch (err) {
      this.connected = false;
      log.error(err.message);
      return Promise.reject(err);
    }
  }

  onDetach(wc: Electron.WebContents) {
    log.info('Detach ledger');
    usb.on('detach', (device) => {
      log.info(
        `Compare devices - ${device.deviceDescriptor.idVendor}: ${this.devices[0].vendorId}`
      );
      if (device.deviceDescriptor.idVendor === this.devices[0].vendorId) {
        wc.send(DETACH_DEVICE_LEDGER);
      }
    });
  }

  async getDefiAppVersion(): Promise<string> {
    if (!this.connected) return '';
    try {
      const apdu = Buffer.from([CLA, INS_GET_VERSION, 0x00, 0x00, 0x00]);
      const response = await this.transport.exchange(apdu);
      const { code, status } = checkStatusCode(response);

      if (code !== StatusCodes.OK) {
        throw new Error(status);
      }

      return response.slice(0, response.length - 2);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async getDefiPublicKey(
    index: number,
    format: AddressFormat = 'legacy'
  ): Promise<{
    pubkey: string;
    address: string;
    chainCode: string;
    privkey: string;
  }> {
    try {
      const apdu = new encoding.BufferWriter();
      apdu.writeUInt8(CLA);
      apdu.writeUInt8(INS_GET_PUBKEY);
      apdu.writeUInt8(GET_PUBKEY_P1_DISPLAY_ADDRESS);
      apdu.writeUInt8(addressFormatToP2(format));

      // key index lenght
      apdu.writeUInt8(4);
      // add 4 bytes index to buffer
      apdu.writeInt32LE(index);
      log.info(`APDU: ${apdu}`);
      const resposne = await this.transport.exchange(apdu.toBuffer());
      log.info(`resposne: ${resposne}`);
      const dataReader = new encoding.BufferReader(resposne);
      const pubkeyLen = dataReader.readUInt8();
      let pubkey: Buffer | string = dataReader.read(pubkeyLen);
      log.info(`Full Pubkey: ${pubkey.toString('hex')}`);
      if (pubkey[0] === UNCOMPRESSED_CONTROL_BYTE) {
        const lastByte = pubkey[64];
        pubkey[0] = lastByte % 2 === 0 ? 0x02 : 0x03;
        pubkey = pubkey.slice(0, 33);
      }
      pubkey = pubkey.toString('hex');
      log.info(`Shot Pubkey: ${pubkey}`);
      const addrLen = dataReader.readUInt8();
      const address = dataReader.read(addrLen).toString('utf-8');
      const chainCode = dataReader.read(32).toString('hex');
      const privkeyLeb = dataReader.readUInt8();
      const privkey = dataReader.read(privkeyLeb).toString('hex');
      log.info(`privkey: ${privkey}`);
      return { pubkey, address, chainCode, privkey };
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async sign(
    keyIndex: number,
    msg: Buffer,
    isHash: boolean = true
  ): Promise<Buffer> {
    const keyIndexBuf = Buffer.alloc(4);
    keyIndexBuf.writeInt32LE(keyIndex, 0);
    const p1 = Buffer.alloc(1);
    let response: Buffer;
    if (isHash) {
      p1.writeInt8(SIGN_VERIFY_P1_ALREADY_HASHED, 0);
      const p2Buf = Buffer.alloc(1);
      p2Buf.writeInt8(SIGN_VERIFY_P2_FIRST | SIGN_VERIFY_P2_LAST, 0);
      const dataLen = msg.length + keyIndexBuf.length;
      const dataLenBuf = Buffer.alloc(1);
      dataLenBuf.writeInt8(dataLen, 0);
      const data = Buffer.concat([keyIndexBuf, msg]);
      const apdu = Buffer.concat([
        new Buffer([CLA, INS_SIGN_MSG]),
        p1,
        p2Buf,
        dataLenBuf,
        data,
      ]);
      response = await this.transport.exchange(apdu);
      const { code, status } = checkStatusCode(response);
      if (code !== StatusCodes.OK) {
        throw new Error(status);
      }
    } else {
      p1.writeInt8(SIGN_VERIFY_P1_NEED_HASH, 0);
      const msgLen = msg.length;
      let stepsNum = 1;
      if (msgLen > MAX_LENGTH_MESSAGE_SIGN) {
        stepsNum = Math.ceil(msgLen / MAX_LENGTH_MESSAGE_SIGN);
      }
      const partSize = Math.floor(msgLen / stepsNum) + 1;
      for (let i = 0; i < stepsNum; i++) {
        const start = i * partSize;
        let finish = (i + 1) * partSize;
        if (finish >= msgLen) {
          finish = msg.length;
        }
        const msgSlice = msg.slice(start, finish);
        let p2: number = 0;
        let data = Buffer.alloc(0);
        let dataLen = 0;
        dataLen += msgSlice.length;
        if (i === 0) {
          p2 =
            SIGN_VERIFY_P2_FIRST |
            (stepsNum === 1 ? SIGN_VERIFY_P2_LAST : SIGN_VERIFY_P2_MORE);
          data = Buffer.concat([data, keyIndexBuf]);
          dataLen += keyIndexBuf.length;
        } else if (i === stepsNum - 1) {
          p2 = SIGN_VERIFY_P2_LAST;
        } else {
          p2 = SIGN_VERIFY_P2_MORE;
        }
        data = Buffer.concat([data, msgSlice]);
        const p2Buf = Buffer.alloc(1);
        p2Buf.writeInt8(p2, 0);
        const dataLenBuf = Buffer.alloc(1);
        dataLenBuf.writeInt8(dataLen, 0);
        const apdu = Buffer.concat([
          new Buffer([CLA, INS_SIGN_MSG]),
          p1,
          p2Buf,
          dataLenBuf,
          data,
        ]);
        response = await this.transport.exchange(apdu);
      }
    }
    const rawTVLSignature = response.slice(0, response.length - 2);
    rawTVLSignature[0] = 0x30;
    return rawTVLSignature;
  }

  async verifySignature(
    keyIndex: number,
    msg: Buffer,
    rawTVLSignature: Buffer
  ) {
    const keyIndexBuf = new encoding.BufferWriter();
    keyIndexBuf.writeInt32LE(keyIndex);
    const msgHash = crypto.Hash.sha256(crypto.Hash.sha256(msg));
    const signVerifyP1AlreadyHashedBuf = Buffer.alloc(1);
    signVerifyP1AlreadyHashedBuf.writeInt8(SIGN_VERIFY_P1_ALREADY_HASHED, 0);
    const signVerifyP2Buf = Buffer.alloc(1);
    signVerifyP2Buf.writeInt8(SIGN_VERIFY_P2_FIRST || SIGN_VERIFY_P2_LAST, 0);
    const lenBuf = Buffer.alloc(1);
    lenBuf.writeUInt8(
      keyIndexBuf.toBuffer().length + rawTVLSignature.length + msgHash.length,
      0
    );
    const apdu = Buffer.concat([
      new Buffer([CLA, INS_VERIFY_MSG]),
      signVerifyP1AlreadyHashedBuf,
      signVerifyP2Buf,
      lenBuf,
      keyIndexBuf.toBuffer(),
      rawTVLSignature,
      msgHash,
    ]);
    const res = await this.transport.exchange(apdu);
    const { code } = checkStatusCode(res);
    if (code !== StatusCodes.OK) {
      return 'NO';
    }
    return 'OK';
  }

  transformationSign(sign: Buffer) {
    const lenR = sign[3];
    const lenS = sign[5 + lenR];
    const offsetR = lenR === 33 ? 1 : 0;
    const offsetS = lenS === 33 ? 1 : 0;
    let transaction = sign.slice(4 + offsetR, 4 + offsetR + 32);
    transaction = Buffer.concat([
      transaction,
      sign.slice(4 + lenR + 2 + offsetS, 4 + lenR + 2 + offsetS + 32),
    ]);
    transaction = Buffer.concat([transaction, new Buffer([0x00])]);
    if (sign[0] === 0x31) {
      // tslint:disable-next-line:no-bitwise
      transaction[64] = transaction[64] | 0x01;
    }
    return transaction;
  }

  async getBackupIndexes() {
    const p1 = 0x00;
    const apdu = new Buffer(new Buffer([CLA, INS_GET_IDXS_BACKUP, p1, 0]));
    const response = await this.transport.exchange(apdu);
    const { code, status } = checkStatusCode(response);
    if (code !== StatusCodes.OK) {
      throw new Error(status);
    } else {
      const nufOfIdxs = response[0];
      const idxsBytes = new encoding.BufferReader(
        response.slice(1, 1 + 4 * nufOfIdxs)
      );
      const idxSize = 4; // 4 bytes
      const idxs = [];
      for (let i = 0; i < nufOfIdxs; i++) {
        idxs.push(idxsBytes.read(idxSize).toString());
      }
      return idxs;
    }
  }

  // Not works
  /*
  async getHwWalletVersion() {
    if (!this.connected)
      throw Error("Device unconnected");

    let result: { targetId: Number, osVersion: String, flags: Number, mcuVersion: String, mcuHash?: String };

    let response: Buffer = await this.transport.exchange(Buffer.from([CLA, 0x00, 0x00, 0x00, 0x01, 0x10]));

    let {code, status} = checkStatusCode(response);

    if (code !== StatusCodes.OK)
      throw Error(status);

    let offset = 0;
    result.targetId = (response[offset] << 24) | (response[offset + 1] << 16) |
      (response[offset + 2] << 8) | response[offset + 3];
    console.log("targetId: " + result.targetId.toString(16));
    offset += 4
    result.osVersion = response.slice(offset + 1, offset + 1 + response[offset]).toString('utf-8');
    console.log("osVersion: " + result.osVersion);
    offset += 1 + response[offset]
    offset += 1
    result.flags = (response[offset] << 24) | (response[offset + 1] << 16) |
      (response[offset + 2] << 8) | response[offset + 3]
    console.log("flags: " + result.flags.toString(16));
    offset += 4
    result.mcuVersion = response.slice(offset + 1, offset + 1 + response[offset] - 1).toString('utf-8')
    console.log("mcuVersion: " + result.mcuVersion);
    offset += 1 + response[offset]
    if (offset < response.length) {
      result.mcuHash = response.slice(offset, offset + 32).toString('utf-8');
      console.log("mcuHash: " + result.mcuHash);
    }
    return result;
  }

  async listHwWalletApps() {

  }
  */
}

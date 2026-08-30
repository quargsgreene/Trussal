// O2lite message serialization — the JS protocol subset for JPattern.
//
// CommonJS on purpose: the O2 relay runs inside the sidecar container
// (CJS, node:20); the browser imports this through the ESM facade at
// src/audio-net/o2lite_driver.js.
//
// Faithful to the O2lite wire shape (network byte order, 4-byte-aligned
// C-strings, ',’-prefixed typespec) but carried over WebSocket frames
// instead of TCP/UDP, so each frame is exactly one message and no length
// prefix is needed. Pure module: ArrayBuffer/DataView + TextEncoder only,
// identical in the browser bundle, the relay, and node:test.
//
// Layout:
//   uint32  flags        (bit 0: reliable/tcp semantics — informational here)
//   float64 timestamp    (seconds in the reference clock; 0 = "now")
//   cstring address      (padded to a 4-byte boundary)
//   cstring typespec     (leading ',', padded to 4)
//   data per typespec:
//     i int32 · f float32 · d float64 · t float64 (time)
//     s cstring padded4 · b blob (uint32 length + bytes padded4) · B int32 0/1

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const O2L_FLAG_TCP = 1;

function paddedLength(byteLen) {
  // +1 for the NUL terminator, then round up to 4.
  return (byteLen + 1 + 3) & ~3;
}

function writeCString(view, bytes, offset, str) {
  const strBytes = encoder.encode(str);
  bytes.set(strBytes, offset);
  const end = offset + paddedLength(strBytes.length);
  bytes.fill(0, offset + strBytes.length, end);
  return end;
}

function readCString(bytes, offset) {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end++;
  const str = decoder.decode(bytes.subarray(offset, end));
  return { str, next: offset + paddedLength(end - offset) };
}

function serializeMessage({ address, typespec = ',', args = [], timestamp = 0, flags = 0 }) {
  if (typeof address !== 'string' || !address.startsWith('/')) {
    throw new TypeError("O2 address must start with '/'");
  }
  const spec = typespec.startsWith(',') ? typespec : `,${typespec}`;
  const types = spec.slice(1);
  if (types.length !== args.length) {
    throw new RangeError(`typespec '${spec}' expects ${types.length} args, got ${args.length}`);
  }

  // Size pass.
  let size = 4 + 8 + paddedLength(encoder.encode(address).length) + paddedLength(encoder.encode(spec).length);
  const argBytes = [];
  for (let k = 0; k < types.length; k++) {
    const t = types[k];
    const a = args[k];
    switch (t) {
      case 'i': case 'B': case 'f': size += 4; break;
      case 'd': case 't': size += 8; break;
      case 's': {
        const b = encoder.encode(String(a));
        argBytes[k] = b;
        size += paddedLength(b.length);
        break;
      }
      case 'b': {
        const b = a instanceof Uint8Array ? a : new Uint8Array(a);
        argBytes[k] = b;
        size += 4 + ((b.length + 3) & ~3);
        break;
      }
      default:
        throw new TypeError(`unsupported O2lite type '${t}'`);
    }
  }

  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let o = 0;
  view.setUint32(o, flags >>> 0, false); o += 4;
  view.setFloat64(o, timestamp, false); o += 8;
  o = writeCString(view, bytes, o, address);
  o = writeCString(view, bytes, o, spec);

  for (let k = 0; k < types.length; k++) {
    const t = types[k];
    const a = args[k];
    switch (t) {
      case 'i': view.setInt32(o, a | 0, false); o += 4; break;
      case 'B': view.setInt32(o, a ? 1 : 0, false); o += 4; break;
      case 'f': view.setFloat32(o, a, false); o += 4; break;
      case 'd': case 't': view.setFloat64(o, a, false); o += 8; break;
      case 's': {
        const b = argBytes[k];
        bytes.set(b, o);
        const end = o + paddedLength(b.length);
        bytes.fill(0, o + b.length, end);
        o = end;
        break;
      }
      case 'b': {
        const b = argBytes[k];
        view.setUint32(o, b.length, false); o += 4;
        bytes.set(b, o);
        const end = o + ((b.length + 3) & ~3);
        bytes.fill(0, o + b.length, end);
        o = end;
        break;
      }
    }
  }
  return buf;
}

function deserializeMessage(buffer) {
  const buf = buffer instanceof ArrayBuffer
    ? buffer
    : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let o = 0;
  const flags = view.getUint32(o, false); o += 4;
  const timestamp = view.getFloat64(o, false); o += 8;
  const addr = readCString(bytes, o);
  o = addr.next;
  const spec = readCString(bytes, o);
  o = spec.next;
  if (!spec.str.startsWith(',')) {
    throw new TypeError('malformed O2lite message: typespec missing leading comma');
  }
  const types = spec.str.slice(1);
  const args = [];
  for (const t of types) {
    switch (t) {
      case 'i': args.push(view.getInt32(o, false)); o += 4; break;
      case 'B': args.push(view.getInt32(o, false) !== 0); o += 4; break;
      case 'f': args.push(view.getFloat32(o, false)); o += 4; break;
      case 'd': case 't': args.push(view.getFloat64(o, false)); o += 8; break;
      case 's': {
        const s = readCString(bytes, o);
        args.push(s.str);
        o = s.next;
        break;
      }
      case 'b': {
        const len = view.getUint32(o, false); o += 4;
        args.push(bytes.slice(o, o + len));
        o += (len + 3) & ~3;
        break;
      }
      default:
        throw new TypeError(`unsupported O2lite type '${t}'`);
    }
  }
  return { address: addr.str, typespec: spec.str, args, timestamp, flags };
}

// Well-known clock-sync addresses (mirrors O2's /_cs service).
const CS_GET = '/_cs/get';
const CS_REPLY = '/_cs/rply';

module.exports = { O2L_FLAG_TCP, serializeMessage, deserializeMessage, CS_GET, CS_REPLY };

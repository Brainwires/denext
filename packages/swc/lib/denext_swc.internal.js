// @generated file from wasmbuild -- do not edit
// @ts-nocheck: generated
// deno-lint-ignore-file
// deno-fmt-ignore-file

/**
 * @param {string} s
 * @param {any} opts
 * @returns {Promise<any>}
 */
export function minify(s, opts) {
  const ret = wasm.minify(s, opts);
  return ret;
}

/**
 * @param {string} s
 * @param {any} opts
 * @returns {any}
 */
export function minifySync(s, opts) {
  const ret = wasm.minifySync(s, opts);
  if (ret[2]) {
    throw takeFromExternrefTable0(ret[1]);
  }
  return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {string} s
 * @param {any} opts
 * @returns {Promise<any>}
 */
export function parse(s, opts) {
  const ret = wasm.parse(s, opts);
  return ret;
}

/**
 * @param {string} s
 * @param {any} opts
 * @returns {any}
 */
export function parseSync(s, opts) {
  const ret = wasm.parseSync(s, opts);
  if (ret[2]) {
    throw takeFromExternrefTable0(ret[1]);
  }
  return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {any} s
 * @param {any} opts
 * @returns {Promise<any>}
 */
export function print(s, opts) {
  const ret = wasm.print(s, opts);
  return ret;
}

/**
 * @param {any} s
 * @param {any} opts
 * @returns {any}
 */
export function printSync(s, opts) {
  const ret = wasm.printSync(s, opts);
  if (ret[2]) {
    throw takeFromExternrefTable0(ret[1]);
  }
  return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {any} s
 * @param {any} opts
 * @param {any} experimental_plugin_bytes_resolver
 * @returns {Promise<any>}
 */
export function transform(s, opts, experimental_plugin_bytes_resolver) {
  const ret = wasm.transform(s, opts, experimental_plugin_bytes_resolver);
  return ret;
}

/**
 * @param {any} s
 * @param {any} opts
 * @param {any} experimental_plugin_bytes_resolver
 * @returns {any}
 */
export function transformSync(s, opts, experimental_plugin_bytes_resolver) {
  const ret = wasm.transformSync(s, opts, experimental_plugin_bytes_resolver);
  if (ret[2]) {
    throw takeFromExternrefTable0(ret[1]);
  }
  return takeFromExternrefTable0(ret[0]);
}
export function __wbg_Error_8c4e43fe74559d73(arg0, arg1) {
  var v0 = getCachedStringFromWasm0(arg0, arg1);
  const ret = Error(v0);
  return ret;
}
export function __wbg_Number_04624de7d0e8332d(arg0) {
  const ret = Number(arg0);
  return ret;
}
export function __wbg_String_8f0eb39a4a4c2f66(arg0, arg1) {
  const ret = String(arg1);
  const ptr1 = passStringToWasm0(
    ret,
    wasm.__wbindgen_malloc,
    wasm.__wbindgen_realloc,
  );
  const len1 = WASM_VECTOR_LEN;
  getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
  getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_bigint_get_as_i64_8fcf4ce7f1ca72a2(
  arg0,
  arg1,
) {
  const v = arg1;
  const ret = typeof v === "bigint" ? v : undefined;
  getDataViewMemory0().setBigInt64(
    arg0 + 8 * 1,
    isLikeNone(ret) ? BigInt(0) : ret,
    true,
  );
  getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
}
export function __wbg___wbindgen_boolean_get_bbbb1c18aa2f5e25(arg0) {
  const v = arg0;
  const ret = typeof v === "boolean" ? v : undefined;
  return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
}
export function __wbg___wbindgen_debug_string_0bc8482c6e3508ae(arg0, arg1) {
  const ret = debugString(arg1);
  const ptr1 = passStringToWasm0(
    ret,
    wasm.__wbindgen_malloc,
    wasm.__wbindgen_realloc,
  );
  const len1 = WASM_VECTOR_LEN;
  getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
  getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_in_47fa6863be6f2f25(arg0, arg1) {
  const ret = arg0 in arg1;
  return ret;
}
export function __wbg___wbindgen_is_bigint_31b12575b56f32fc(arg0) {
  const ret = typeof arg0 === "bigint";
  return ret;
}
export function __wbg___wbindgen_is_function_0095a73b8b156f76(arg0) {
  const ret = typeof arg0 === "function";
  return ret;
}
export function __wbg___wbindgen_is_null_ac34f5003991759a(arg0) {
  const ret = arg0 === null;
  return ret;
}
export function __wbg___wbindgen_is_object_5ae8e5880f2c1fbd(arg0) {
  const val = arg0;
  const ret = typeof val === "object" && val !== null;
  return ret;
}
export function __wbg___wbindgen_is_string_cd444516edc5b180(arg0) {
  const ret = typeof arg0 === "string";
  return ret;
}
export function __wbg___wbindgen_is_undefined_9e4d92534c42d778(arg0) {
  const ret = arg0 === undefined;
  return ret;
}
export function __wbg___wbindgen_jsval_eq_11888390b0186270(arg0, arg1) {
  const ret = arg0 === arg1;
  return ret;
}
export function __wbg___wbindgen_jsval_loose_eq_9dd77d8cd6671811(arg0, arg1) {
  const ret = arg0 == arg1;
  return ret;
}
export function __wbg___wbindgen_number_get_8ff4255516ccad3e(arg0, arg1) {
  const obj = arg1;
  const ret = typeof obj === "number" ? obj : undefined;
  getDataViewMemory0().setFloat64(
    arg0 + 8 * 1,
    isLikeNone(ret) ? 0 : ret,
    true,
  );
  getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
}
export function __wbg___wbindgen_string_get_72fb696202c56729(arg0, arg1) {
  const obj = arg1;
  const ret = typeof obj === "string" ? obj : undefined;
  var ptr1 = isLikeNone(ret)
    ? 0
    : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
  var len1 = WASM_VECTOR_LEN;
  getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
  getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_throw_be289d5034ed271b(arg0, arg1) {
  var v0 = getCachedStringFromWasm0(arg0, arg1);
  throw new Error(v0);
}
export function __wbg__wbg_cb_unref_d9b87ff7982e3b21(arg0) {
  arg0._wbg_cb_unref();
}
export function __wbg_call_389efe28435a9388() {
  return handleError(function (arg0, arg1) {
    const ret = arg0.call(arg1);
    return ret;
  }, arguments);
}
export function __wbg_call_4708e0c13bdc8e95() {
  return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.call(arg1, arg2);
    return ret;
  }, arguments);
}
export function __wbg_done_57b39ecd9addfe81(arg0) {
  const ret = arg0.done;
  return ret;
}
export function __wbg_entries_58c7934c745daac7(arg0) {
  const ret = Object.entries(arg0);
  return ret;
}
export function __wbg_error_7534b8e9a36f1ab4(arg0, arg1) {
  var v0 = getCachedStringFromWasm0(arg0, arg1);
  if (arg0 !== 0) wasm.__wbindgen_free(arg0, arg1, 1);
  console.error(v0);
}
export function __wbg_getRandomValues_1c61fac11405ffdc() {
  return handleError(function (arg0, arg1) {
    globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
  }, arguments);
}
export function __wbg_get_9b94d73e6221f75c(arg0, arg1) {
  const ret = arg0[arg1 >>> 0];
  return ret;
}
export function __wbg_get_b3ed3ad4be2bc8ac() {
  return handleError(function (arg0, arg1) {
    const ret = Reflect.get(arg0, arg1);
    return ret;
  }, arguments);
}
export function __wbg_get_with_ref_key_1dc361bd10053bfe(arg0, arg1) {
  const ret = arg0[arg1];
  return ret;
}
export function __wbg_instanceof_ArrayBuffer_c367199e2fa2aa04(arg0) {
  let result;
  try {
    result = arg0 instanceof ArrayBuffer;
  } catch (_) {
    result = false;
  }
  const ret = result;
  return ret;
}
export function __wbg_instanceof_Map_53af74335dec57f4(arg0) {
  let result;
  try {
    result = arg0 instanceof Map;
  } catch (_) {
    result = false;
  }
  const ret = result;
  return ret;
}
export function __wbg_instanceof_Uint8Array_9b9075935c74707c(arg0) {
  let result;
  try {
    result = arg0 instanceof Uint8Array;
  } catch (_) {
    result = false;
  }
  const ret = result;
  return ret;
}
export function __wbg_isArray_d314bb98fcf08331(arg0) {
  const ret = Array.isArray(arg0);
  return ret;
}
export function __wbg_isSafeInteger_bfbc7332a9768d2a(arg0) {
  const ret = Number.isSafeInteger(arg0);
  return ret;
}
export function __wbg_iterator_6ff6560ca1568e55() {
  const ret = Symbol.iterator;
  return ret;
}
export function __wbg_length_32ed9a279acd054c(arg0) {
  const ret = arg0.length;
  return ret;
}
export function __wbg_length_35a7bace40f36eac(arg0) {
  const ret = arg0.length;
  return ret;
}
export function __wbg_new_361308b2356cecd0() {
  const ret = new Object();
  return ret;
}
export function __wbg_new_3eb36ae241fe6f44() {
  const ret = new Array();
  return ret;
}
export function __wbg_new_8a6f238a6ece86ea() {
  const ret = new Error();
  return ret;
}
export function __wbg_new_b5d9e2fb389fef91(arg0, arg1) {
  try {
    var state0 = { a: arg0, b: arg1 };
    var cb0 = (arg0, arg1) => {
      const a = state0.a;
      state0.a = 0;
      try {
        return wasm_bindgen__convert__closures_____invoke__h78e24f47e0a12957(
          a,
          state0.b,
          arg0,
          arg1,
        );
      } finally {
        state0.a = a;
      }
    };
    const ret = new Promise(cb0);
    return ret;
  } finally {
    state0.a = state0.b = 0;
  }
}
export function __wbg_new_dca287b076112a51() {
  const ret = new Map();
  return ret;
}
export function __wbg_new_dd2b680c8bf6ae29(arg0) {
  const ret = new Uint8Array(arg0);
  return ret;
}
export function __wbg_new_no_args_1c7c842f08d00ebb(arg0, arg1) {
  var v0 = getCachedStringFromWasm0(arg0, arg1);
  const ret = new Function(v0);
  return ret;
}
export function __wbg_next_3482f54c49e8af19() {
  return handleError(function (arg0) {
    const ret = arg0.next();
    return ret;
  }, arguments);
}
export function __wbg_next_418f80d8f5303233(arg0) {
  const ret = arg0.next;
  return ret;
}
export function __wbg_prototypesetcall_bdcdcc5842e4d77d(arg0, arg1, arg2) {
  Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
}
export function __wbg_queueMicrotask_0aa0a927f78f5d98(arg0) {
  const ret = arg0.queueMicrotask;
  return ret;
}
export function __wbg_queueMicrotask_5bb536982f78a56f(arg0) {
  queueMicrotask(arg0);
}
export function __wbg_resolve_002c4b7d9d8f6b64(arg0) {
  const ret = Promise.resolve(arg0);
  return ret;
}
export function __wbg_set_1eb0999cf5d27fc8(arg0, arg1, arg2) {
  const ret = arg0.set(arg1, arg2);
  return ret;
}
export function __wbg_set_3f1d0b984ed272ed(arg0, arg1, arg2) {
  arg0[arg1] = arg2;
}
export function __wbg_set_f43e577aea94465b(arg0, arg1, arg2) {
  arg0[arg1 >>> 0] = arg2;
}
export function __wbg_stack_0ed75d68575b0f3c(arg0, arg1) {
  const ret = arg1.stack;
  const ptr1 = passStringToWasm0(
    ret,
    wasm.__wbindgen_malloc,
    wasm.__wbindgen_realloc,
  );
  const len1 = WASM_VECTOR_LEN;
  getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
  getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_static_accessor_GLOBAL_12837167ad935116() {
  const ret = typeof global === "undefined" ? null : global;
  return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_GLOBAL_THIS_e628e89ab3b1c95f() {
  const ret = typeof globalThis === "undefined" ? null : globalThis;
  return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_SELF_a621d3dfbb60d0ce() {
  const ret = typeof self === "undefined" ? null : self;
  return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_WINDOW_f8727f0cf888e0bd() {
  const ret = typeof window === "undefined" ? null : window;
  return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_then_b9e7b3b5f1a9e1b5(arg0, arg1) {
  const ret = arg0.then(arg1);
  return ret;
}
export function __wbg_value_0546255b415e96c1(arg0) {
  const ret = arg0.value;
  return ret;
}
export function __wbindgen_cast_0000000000000001(arg0, arg1) {
  // Cast intrinsic for `Closure(Closure { dtor_idx: 894, function: Function { arguments: [Externref], shim_idx: 895, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
  const ret = makeMutClosure(
    arg0,
    arg1,
    wasm.wasm_bindgen__closure__destroy__h564afdbfc2abc434,
    wasm_bindgen__convert__closures_____invoke__h288e0a182bb5a46a,
  );
  return ret;
}
export function __wbindgen_cast_0000000000000002(arg0) {
  // Cast intrinsic for `F64 -> Externref`.
  const ret = arg0;
  return ret;
}
export function __wbindgen_cast_0000000000000003(arg0) {
  // Cast intrinsic for `I64 -> Externref`.
  const ret = arg0;
  return ret;
}
export function __wbindgen_cast_0000000000000004(arg0, arg1) {
  var v0 = getCachedStringFromWasm0(arg0, arg1);
  // Cast intrinsic for `Ref(CachedString) -> Externref`.
  const ret = v0;
  return ret;
}
export function __wbindgen_cast_0000000000000005(arg0) {
  // Cast intrinsic for `U64 -> Externref`.
  const ret = BigInt.asUintN(64, arg0);
  return ret;
}
export function __wbindgen_init_externref_table() {
  const table = wasm.__wbindgen_externrefs;
  const offset = table.grow(4);
  table.set(0, undefined);
  table.set(offset + 0, undefined);
  table.set(offset + 1, null);
  table.set(offset + 2, true);
  table.set(offset + 3, false);
}
function wasm_bindgen__convert__closures_____invoke__h288e0a182bb5a46a(
  arg0,
  arg1,
  arg2,
) {
  wasm.wasm_bindgen__convert__closures_____invoke__h288e0a182bb5a46a(
    arg0,
    arg1,
    arg2,
  );
}

function wasm_bindgen__convert__closures_____invoke__h78e24f47e0a12957(
  arg0,
  arg1,
  arg2,
  arg3,
) {
  wasm.wasm_bindgen__convert__closures_____invoke__h78e24f47e0a12957(
    arg0,
    arg1,
    arg2,
    arg3,
  );
}

function addToExternrefTable0(obj) {
  const idx = wasm.__externref_table_alloc();
  wasm.__wbindgen_externrefs.set(idx, obj);
  return idx;
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === "undefined")
  ? { register: () => {}, unregister: () => {} }
  : new FinalizationRegistry((state) => state.dtor(state.a, state.b));

function debugString(val) {
  // primitive types
  const type = typeof val;
  if (type == "number" || type == "boolean" || val == null) {
    return `${val}`;
  }
  if (type == "string") {
    return `"${val}"`;
  }
  if (type == "symbol") {
    const description = val.description;
    if (description == null) {
      return "Symbol";
    } else {
      return `Symbol(${description})`;
    }
  }
  if (type == "function") {
    const name = val.name;
    if (typeof name == "string" && name.length > 0) {
      return `Function(${name})`;
    } else {
      return "Function";
    }
  }
  // objects
  if (Array.isArray(val)) {
    const length = val.length;
    let debug = "[";
    if (length > 0) {
      debug += debugString(val[0]);
    }
    for (let i = 1; i < length; i++) {
      debug += ", " + debugString(val[i]);
    }
    debug += "]";
    return debug;
  }
  // Test for built-in
  const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
  let className;
  if (builtInMatches && builtInMatches.length > 1) {
    className = builtInMatches[1];
  } else {
    // Failed to match the standard '[object ClassName]'
    return toString.call(val);
  }
  if (className == "Object") {
    // we're a user defined class or Object
    // JSON.stringify avoids problems with cycles, and is generally much
    // easier than looping through ownProperties of `val`.
    try {
      return "Object(" + JSON.stringify(val) + ")";
    } catch (_) {
      return "Object";
    }
  }
  // errors
  if (val instanceof Error) {
    return `${val.name}: ${val.message}\n${val.stack}`;
  }
  // TODO we could test for more things here, like `Set`s and `Map`s.
  return className;
}

function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getCachedStringFromWasm0(ptr, len) {
  if (ptr === 0) {
    return getFromExternrefTable0(len);
  } else {
    return getStringFromWasm0(ptr, len);
  }
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
  if (
    cachedDataViewMemory0 === null ||
    cachedDataViewMemory0.buffer.detached === true ||
    (cachedDataViewMemory0.buffer.detached === undefined &&
      cachedDataViewMemory0.buffer !== wasm.memory.buffer)
  ) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
  }
  return cachedDataViewMemory0;
}

function getFromExternrefTable0(idx) {
  return wasm.__wbindgen_externrefs.get(idx);
}

function getStringFromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (
    cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0
  ) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
  try {
    return f.apply(this, args);
  } catch (e) {
    const idx = addToExternrefTable0(e);
    wasm.__wbindgen_exn_store(idx);
  }
}

function isLikeNone(x) {
  return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, dtor, f) {
  const state = { a: arg0, b: arg1, cnt: 1, dtor };
  const real = (...args) => {
    // First up with a closure we increment the internal reference
    // count. This ensures that the Rust closure environment won't
    // be deallocated while we're invoking it.
    state.cnt++;
    const a = state.a;
    state.a = 0;
    try {
      return f(a, state.b, ...args);
    } finally {
      state.a = a;
      real._wbg_cb_unref();
    }
  };
  real._wbg_cb_unref = () => {
    if (--state.cnt === 0) {
      state.dtor(state.a, state.b);
      state.a = 0;
      CLOSURE_DTORS.unregister(state);
    }
  };
  CLOSURE_DTORS.register(real, state, state);
  return real;
}

function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === undefined) {
    const buf = cachedTextEncoder.encode(arg);
    const ptr = malloc(buf.length, 1) >>> 0;
    getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
    WASM_VECTOR_LEN = buf.length;
    return ptr;
  }

  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;

  const mem = getUint8ArrayMemory0();

  let offset = 0;

  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 0x7F) break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset);
    }
    ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
    const ret = cachedTextEncoder.encodeInto(arg, view);

    offset += ret.written;
    ptr = realloc(ptr, len, offset, 1) >>> 0;
  }

  WASM_VECTOR_LEN = offset;
  return ptr;
}

function takeFromExternrefTable0(idx) {
  const value = wasm.__wbindgen_externrefs.get(idx);
  wasm.__externref_table_dealloc(idx);
  return value;
}

let cachedTextDecoder = new TextDecoder("utf-8", {
  ignoreBOM: true,
  fatal: true,
});
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
  numBytesDecoded += len;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder("utf-8", {
      ignoreBOM: true,
      fatal: true,
    });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(
    getUint8ArrayMemory0().subarray(ptr, ptr + len),
  );
}

const cachedTextEncoder = new TextEncoder();

if (!("encodeInto" in cachedTextEncoder)) {
  cachedTextEncoder.encodeInto = function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
      read: arg.length,
      written: buf.length,
    };
  };
}

let WASM_VECTOR_LEN = 0;

let wasm;
export function __wbg_set_wasm(val) {
  wasm = val;
}

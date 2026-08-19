// @generated file from wasmbuild -- do not edit
// @ts-nocheck: generated
// deno-lint-ignore-file
// deno-fmt-ignore-file

import {
  closeSync,
  existsSync,
  fdatasyncSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";

export class WasmDatabase {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(WasmDatabase.prototype);
    obj.__wbg_ptr = ptr;
    WasmDatabaseFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    WasmDatabaseFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_wasmdatabase_free(ptr, 0);
  }
  close() {
    const ptr = this.__destroy_into_raw();
    wasm.wasmdatabase_close(ptr);
  }
  /**
   * Register a JavaScript callback as a SQL scalar function.
   *
   * The callback receives the evaluated arguments as JS values and must
   * return synchronously (async callbacks are deferred to a later
   * release). Pass `n_args = -1` for variadic.
   *
   * User-defined functions cannot shadow built-ins — the engine resolves
   * known names (`UPPER`, `JSON_EXTRACT`, `vec_distance_cosine`, …) before
   * consulting the UDF registry.
   * @param {string} name
   * @param {number} n_args
   * @param {Function} callback
   */
  createFunction(name, n_args, callback) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.wasmdatabase_createFunction(this.__wbg_ptr, ptr0, len0, n_args, callback);
  }
  /**
   * Remove a previously-registered user-defined function. Returns true if
   * a function by that name existed.
   * @param {string} name
   * @returns {boolean}
   */
  deleteFunction(name) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmdatabase_deleteFunction(this.__wbg_ptr, ptr0, len0);
    return ret !== 0;
  }
  /**
   * @param {string} sql
   * @returns {bigint}
   */
  exec(sql) {
    const ptr0 = passStringToWasm0(sql, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmdatabase_exec(this.__wbg_ptr, ptr0, len0);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return BigInt.asUintN(64, ret[0]);
  }
  /**
   * @param {string} sql
   */
  execMany(sql) {
    const ptr0 = passStringToWasm0(sql, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmdatabase_execMany(this.__wbg_ptr, ptr0, len0);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {string} sql
   * @param {any} params
   * @returns {bigint}
   */
  execParams(sql, params) {
    const ptr0 = passStringToWasm0(sql, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmdatabase_execParams(this.__wbg_ptr, ptr0, len0, params);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return BigInt.asUintN(64, ret[0]);
  }
  flush() {
    const ret = wasm.wasmdatabase_flush(this.__wbg_ptr);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Uint8Array} data
   * @returns {WasmDatabase}
   */
  static fromBuffer(data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmdatabase_fromBuffer(ptr0, len0);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return WasmDatabase.__wrap(ret[0]);
  }
  constructor() {
    const ret = wasm.wasmdatabase_new();
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    this.__wbg_ptr = ret[0] >>> 0;
    WasmDatabaseFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
  /**
   * @returns {WasmDatabase}
   */
  static openInMemory() {
    const ret = wasm.wasmdatabase_openInMemory();
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return WasmDatabase.__wrap(ret[0]);
  }
  /**
   * @param {string} name
   * @param {bigint | null} [chunk_size]
   * @param {number | null} [max_shards]
   * @returns {Promise<WasmDatabase>}
   */
  static openPersisted(name, chunk_size, max_shards) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmdatabase_openPersisted(
      ptr0,
      len0,
      !isLikeNone(chunk_size),
      isLikeNone(chunk_size) ? BigInt(0) : chunk_size,
      isLikeNone(max_shards) ? 0x100000001 : max_shards >>> 0,
    );
    return ret;
  }
  /**
   * Open (or create) a database backed by a real file on the host
   * filesystem, via `node:fs`. Available on the Node/Deno build only.
   * Synchronous — unlike the OPFS/IDB backends there are no async handles to
   * pre-register. `path` is used verbatim (absolute or relative to cwd).
   * @param {string} path
   * @returns {WasmDatabase}
   */
  static openWithFile(path) {
    const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmdatabase_openWithFile(ptr0, len0);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return WasmDatabase.__wrap(ret[0]);
  }
  /**
   * @param {string} name
   * @param {bigint | null} [chunk_size]
   * @returns {Promise<WasmDatabase>}
   */
  static openWithIdb(name, chunk_size) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmdatabase_openWithIdb(
      ptr0,
      len0,
      !isLikeNone(chunk_size),
      isLikeNone(chunk_size) ? BigInt(0) : chunk_size,
    );
    return ret;
  }
  /**
   * @param {string} name
   * @param {bigint | null} [chunk_size]
   * @param {number | null} [max_shards]
   * @returns {Promise<WasmDatabase>}
   */
  static openWithOpfs(name, chunk_size, max_shards) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmdatabase_openWithOpfs(
      ptr0,
      len0,
      !isLikeNone(chunk_size),
      isLikeNone(chunk_size) ? BigInt(0) : chunk_size,
      isLikeNone(max_shards) ? 0x100000001 : max_shards >>> 0,
    );
    return ret;
  }
  /**
   * @param {string} sql
   * @returns {any}
   */
  query(sql) {
    const ptr0 = passStringToWasm0(sql, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmdatabase_query(this.__wbg_ptr, ptr0, len0);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
  }
  /**
   * @param {string} sql
   * @returns {any}
   */
  queryOne(sql) {
    const ptr0 = passStringToWasm0(sql, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmdatabase_queryOne(this.__wbg_ptr, ptr0, len0);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
  }
  /**
   * @param {string} sql
   * @param {any} params
   * @returns {any}
   */
  queryParams(sql, params) {
    const ptr0 = passStringToWasm0(sql, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmdatabase_queryParams(this.__wbg_ptr, ptr0, len0, params);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
  }
  /**
   * @returns {Uint8Array}
   */
  toBuffer() {
    const ret = wasm.wasmdatabase_toBuffer(this.__wbg_ptr);
    if (ret[3]) {
      throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
  }
}
if (Symbol.dispose) WasmDatabase.prototype[Symbol.dispose] = WasmDatabase.prototype.free;

export function init() {
  wasm.init();
}
export function __wbg_Error_8c4e43fe74559d73(arg0, arg1) {
  const ret = Error(getStringFromWasm0(arg0, arg1));
  return ret;
}
export function __wbg___wbindgen_debug_string_0bc8482c6e3508ae(arg0, arg1) {
  const ret = debugString(arg1);
  const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
  const len1 = WASM_VECTOR_LEN;
  getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
  getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_is_function_0095a73b8b156f76(arg0) {
  const ret = typeof arg0 === "function";
  return ret;
}
export function __wbg___wbindgen_is_null_ac34f5003991759a(arg0) {
  const ret = arg0 === null;
  return ret;
}
export function __wbg___wbindgen_is_undefined_9e4d92534c42d778(arg0) {
  const ret = arg0 === undefined;
  return ret;
}
export function __wbg___wbindgen_number_get_8ff4255516ccad3e(arg0, arg1) {
  const obj = arg1;
  const ret = typeof obj === "number" ? obj : undefined;
  getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
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
  throw new Error(getStringFromWasm0(arg0, arg1));
}
export function __wbg__wbg_cb_unref_d9b87ff7982e3b21(arg0) {
  arg0._wbg_cb_unref();
}
export function __wbg_apply_ada2ee1a60ac7b3c() {
  return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.apply(arg1, arg2);
    return ret;
  }, arguments);
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
export function __wbg_closeSync_3c88db9c60b226bf() {
  return handleError(function (arg0) {
    closeSync(arg0);
  }, arguments);
}
export function __wbg_close_4ba312253c424342(arg0) {
  arg0.close();
}
export function __wbg_close_53683f4809368fc7(arg0) {
  arg0.close();
}
export function __wbg_contains_bde74fed714d6521(arg0, arg1, arg2) {
  const ret = arg0.contains(getStringFromWasm0(arg1, arg2));
  return ret;
}
export function __wbg_createObjectStore_545ee23ffd61e3fc() {
  return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.createObjectStore(getStringFromWasm0(arg1, arg2));
    return ret;
  }, arguments);
}
export function __wbg_createSyncAccessHandle_6457c2b3542fa571(arg0) {
  const ret = arg0.createSyncAccessHandle();
  return ret;
}
export function __wbg_error_7534b8e9a36f1ab4(arg0, arg1) {
  let deferred0_0;
  let deferred0_1;
  try {
    deferred0_0 = arg0;
    deferred0_1 = arg1;
    console.error(getStringFromWasm0(arg0, arg1));
  } finally {
    wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
  }
}
export function __wbg_error_9a7fe3f932034cde(arg0) {
  console.error(arg0);
}
export function __wbg_existsSync_3e7254709de8b2cb(arg0, arg1) {
  const ret = existsSync(getStringFromWasm0(arg0, arg1));
  return ret;
}
export function __wbg_fdatasyncSync_e0d6182fd749a6b7() {
  return handleError(function (arg0) {
    fdatasyncSync(arg0);
  }, arguments);
}
export function __wbg_flush_22b785060592ca5f() {
  return handleError(function (arg0) {
    arg0.flush();
  }, arguments);
}
export function __wbg_fstatSync_3826518833b66e36() {
  return handleError(function (arg0) {
    const ret = fstatSync(arg0);
    return ret;
  }, arguments);
}
export function __wbg_fsyncSync_ad886394d2375c70() {
  return handleError(function (arg0) {
    fsyncSync(arg0);
  }, arguments);
}
export function __wbg_ftruncateSync_11c99e2012bfa05a() {
  return handleError(function (arg0, arg1) {
    ftruncateSync(arg0, arg1);
  }, arguments);
}
export function __wbg_getAllKeys_c69c2b19589fffe6() {
  return handleError(function (arg0) {
    const ret = arg0.getAllKeys();
    return ret;
  }, arguments);
}
export function __wbg_getDirectory_b66ae3e79f902982(arg0) {
  const ret = arg0.getDirectory();
  return ret;
}
export function __wbg_getFileHandle_ff4ab917b45affb3(arg0, arg1, arg2, arg3) {
  const ret = arg0.getFileHandle(getStringFromWasm0(arg1, arg2), arg3);
  return ret;
}
export function __wbg_getSize_0a848f6914efc400() {
  return handleError(function (arg0) {
    const ret = arg0.getSize();
    return ret;
  }, arguments);
}
export function __wbg_get_5e856edb32ac1289() {
  return handleError(function (arg0, arg1) {
    const ret = arg0.get(arg1);
    return ret;
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
export function __wbg_length_32ed9a279acd054c(arg0) {
  const ret = arg0.length;
  return ret;
}
export function __wbg_length_35a7bace40f36eac(arg0) {
  const ret = arg0.length;
  return ret;
}
export function __wbg_navigator_4478931f32ebca57(arg0) {
  const ret = arg0.navigator;
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
        return wasm_bindgen__convert__closures_____invoke__h076d3a08615d3d57(
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
export function __wbg_new_from_slice_a3d2629dc1826784(arg0, arg1) {
  const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
  return ret;
}
export function __wbg_new_no_args_1c7c842f08d00ebb(arg0, arg1) {
  const ret = new Function(getStringFromWasm0(arg0, arg1));
  return ret;
}
export function __wbg_new_with_length_a2c39cbe88fd8ff1(arg0) {
  const ret = new Uint8Array(arg0 >>> 0);
  return ret;
}
export function __wbg_objectStoreNames_d2c5d2377420ad78(arg0) {
  const ret = arg0.objectStoreNames;
  return ret;
}
export function __wbg_objectStore_d56e603390dcc165() {
  return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.objectStore(getStringFromWasm0(arg1, arg2));
    return ret;
  }, arguments);
}
export function __wbg_openSync_32dc4f8f2796891f() {
  return handleError(function (arg0, arg1, arg2, arg3) {
    const ret = openSync(getStringFromWasm0(arg0, arg1), getStringFromWasm0(arg2, arg3));
    return ret;
  }, arguments);
}
export function __wbg_open_82db86fd5b087109() {
  return handleError(function (arg0, arg1, arg2, arg3) {
    const ret = arg0.open(getStringFromWasm0(arg1, arg2), arg3 >>> 0);
    return ret;
  }, arguments);
}
export function __wbg_prototypesetcall_bdcdcc5842e4d77d(arg0, arg1, arg2) {
  Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
}
export function __wbg_push_8ffdcb2063340ba5(arg0, arg1) {
  const ret = arg0.push(arg1);
  return ret;
}
export function __wbg_put_b34701a38436f20a() {
  return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.put(arg1, arg2);
    return ret;
  }, arguments);
}
export function __wbg_queueMicrotask_0aa0a927f78f5d98(arg0) {
  const ret = arg0.queueMicrotask;
  return ret;
}
export function __wbg_queueMicrotask_5bb536982f78a56f(arg0) {
  queueMicrotask(arg0);
}
export function __wbg_readSync_e58456a65e103764() {
  return handleError(function (arg0, arg1, arg2, arg3, arg4) {
    const ret = readSync(arg0, arg1, arg2 >>> 0, arg3 >>> 0, arg4);
    return ret;
  }, arguments);
}
export function __wbg_read_f161889777645afd() {
  return handleError(function (arg0, arg1, arg2, arg3) {
    const ret = arg0.read(getArrayU8FromWasm0(arg1, arg2), arg3);
    return ret;
  }, arguments);
}
export function __wbg_resolve_002c4b7d9d8f6b64(arg0) {
  const ret = Promise.resolve(arg0);
  return ret;
}
export function __wbg_result_233b2d68aae87a05() {
  return handleError(function (arg0) {
    const ret = arg0.result;
    return ret;
  }, arguments);
}
export function __wbg_set_6cb8631f80447a67() {
  return handleError(function (arg0, arg1, arg2) {
    const ret = Reflect.set(arg0, arg1, arg2);
    return ret;
  }, arguments);
}
export function __wbg_set_at_e453cf3f4be9e2d9(arg0, arg1) {
  arg0.at = arg1;
}
export function __wbg_set_cc56eefd2dd91957(arg0, arg1, arg2) {
  arg0.set(getArrayU8FromWasm0(arg1, arg2));
}
export function __wbg_set_create_1f902c5936adde7d(arg0, arg1) {
  arg0.create = arg1 !== 0;
}
export function __wbg_set_onupgradeneeded_c887b74722b6ce77(arg0, arg1) {
  arg0.onupgradeneeded = arg1;
}
export function __wbg_stack_0ed75d68575b0f3c(arg0, arg1) {
  const ret = arg1.stack;
  const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
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
export function __wbg_storage_c002b53bc4883299(arg0) {
  const ret = arg0.storage;
  return ret;
}
export function __wbg_stringify_8d1cc6ff383e8bae() {
  return handleError(function (arg0) {
    const ret = JSON.stringify(arg0);
    return ret;
  }, arguments);
}
export function __wbg_subarray_a96e1fef17ed23cb(arg0, arg1, arg2) {
  const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
  return ret;
}
export function __wbg_target_521be630ab05b11e(arg0) {
  const ret = arg0.target;
  return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_then_0d9fe2c7b1857d32(arg0, arg1, arg2) {
  const ret = arg0.then(arg1, arg2);
  return ret;
}
export function __wbg_then_b9e7b3b5f1a9e1b5(arg0, arg1) {
  const ret = arg0.then(arg1);
  return ret;
}
export function __wbg_transaction_55ceb96f4b852417() {
  return handleError(function (arg0, arg1, arg2, arg3) {
    const ret = arg0.transaction(
      getStringFromWasm0(arg1, arg2),
      __wbindgen_enum_IdbTransactionMode[arg3],
    );
    return ret;
  }, arguments);
}
export function __wbg_transaction_bf0a35e0542d8e7a() {
  return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.transaction(getStringFromWasm0(arg1, arg2));
    return ret;
  }, arguments);
}
export function __wbg_truncate_ce7c4fbc0eec97a1() {
  return handleError(function (arg0, arg1) {
    arg0.truncate(arg1);
  }, arguments);
}
export function __wbg_unlinkSync_b4b12078391d2098() {
  return handleError(function (arg0, arg1) {
    unlinkSync(getStringFromWasm0(arg0, arg1));
  }, arguments);
}
export function __wbg_warn_f7ae1b2e66ccb930(arg0) {
  console.warn(arg0);
}
export function __wbg_wasmdatabase_new(arg0) {
  const ret = WasmDatabase.__wrap(arg0);
  return ret;
}
export function __wbg_writeSync_4fc71b711b716024() {
  return handleError(function (arg0, arg1, arg2, arg3, arg4) {
    const ret = writeSync(arg0, arg1, arg2 >>> 0, arg3 >>> 0, arg4);
    return ret;
  }, arguments);
}
export function __wbg_write_2d59337cc496919d() {
  return handleError(function (arg0, arg1, arg2, arg3) {
    const ret = arg0.write(getArrayU8FromWasm0(arg1, arg2), arg3);
    return ret;
  }, arguments);
}
export function __wbindgen_cast_0000000000000001(arg0, arg1) {
  // Cast intrinsic for `Closure(Closure { dtor_idx: 2200, function: Function { arguments: [NamedExternref("Event")], shim_idx: 2201, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
  const ret = makeMutClosure(
    arg0,
    arg1,
    wasm.wasm_bindgen__closure__destroy__hb0bf44198970b8bf,
    wasm_bindgen__convert__closures_____invoke__h068662f65f9769e4,
  );
  return ret;
}
export function __wbindgen_cast_0000000000000002(arg0, arg1) {
  // Cast intrinsic for `Closure(Closure { dtor_idx: 72, function: Function { arguments: [Externref], shim_idx: 73, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
  const ret = makeMutClosure(
    arg0,
    arg1,
    wasm.wasm_bindgen__closure__destroy__hcb3eee76b2e0b911,
    wasm_bindgen__convert__closures_____invoke__h0ee809e0473009b4,
  );
  return ret;
}
export function __wbindgen_cast_0000000000000003(arg0) {
  // Cast intrinsic for `F64 -> Externref`.
  const ret = arg0;
  return ret;
}
export function __wbindgen_cast_0000000000000004(arg0, arg1) {
  // Cast intrinsic for `Ref(String) -> Externref`.
  const ret = getStringFromWasm0(arg0, arg1);
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
function wasm_bindgen__convert__closures_____invoke__h068662f65f9769e4(arg0, arg1, arg2) {
  wasm.wasm_bindgen__convert__closures_____invoke__h068662f65f9769e4(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__h0ee809e0473009b4(arg0, arg1, arg2) {
  wasm.wasm_bindgen__convert__closures_____invoke__h0ee809e0473009b4(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__h076d3a08615d3d57(arg0, arg1, arg2, arg3) {
  wasm.wasm_bindgen__convert__closures_____invoke__h076d3a08615d3d57(arg0, arg1, arg2, arg3);
}

const __wbindgen_enum_IdbTransactionMode = [
  "readonly",
  "readwrite",
  "versionchange",
  "readwriteflush",
  "cleanup",
];
const WasmDatabaseFinalization = (typeof FinalizationRegistry === "undefined")
  ? { register: () => {}, unregister: () => {} }
  : new FinalizationRegistry((ptr) => wasm.__wbg_wasmdatabase_free(ptr >>> 0, 1));

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

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
  if (
    cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true ||
    (cachedDataViewMemory0.buffer.detached === undefined &&
      cachedDataViewMemory0.buffer !== wasm.memory.buffer)
  ) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
  }
  return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
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

function passArray8ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 1, 1) >>> 0;
  getUint8ArrayMemory0().set(arg, ptr / 1);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
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

let cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
  numBytesDecoded += len;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
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

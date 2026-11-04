/**
 * # denext/action-stub — the browser stub of a `"use server"` export
 *
 * The build replaces a `"use server"` module a client module imports with a generated stub that
 * imports {@linkcode clientActionStub} from here: each export becomes a callable that POSTs to the
 * action endpoint. App code does not import it.
 *
 * It is its own entrypoint, not part of the generated entries' `denext/client-runtime` barrel:
 * the bundler places code by FILE, and the stub needs the wire encoder, so the barrel's re-export
 * put the encoder's file in reach of every page's startup graph — where the Flight client's
 * on-demand action call then hoisted the encoder into the startup chunks.
 *
 * @module
 */

export { clientActionStub } from "./runtime/action-stub.ts";

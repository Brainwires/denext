// /api/signal?room=<name> — the signalling hub (lib/signal/hub.ts) as a route handler.
//   GET  ?room=&id=&role=sender|viewer  join the room; an SSE stream of welcome / join / leave /
//                                       message events
//   POST ?room=  { from, token, to, data }  relay one message (offer, answer, ICE candidate,
//                                       restart) to a peer of the room
// No body cap override: the hub refuses anything over 64 KiB itself.

import { sharedHub } from "../../../lib/signal/shared-hub.ts";

export function GET(request: Request): Promise<Response> {
  return sharedHub().handle(request);
}

export function POST(request: Request): Promise<Response> {
  return sharedHub().handle(request);
}

export function OPTIONS(request: Request): Promise<Response> {
  return sharedHub().handle(request);
}

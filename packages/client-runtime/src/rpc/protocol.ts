import { WsRpcGroup } from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import { RpcClient } from "effect/unstable/rpc";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

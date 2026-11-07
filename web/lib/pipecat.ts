import { PipecatClient, type RTVIEventCallbacks } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";

import { AGENT_URL } from "./config";

// Client-side transport factory: the only place that knows which voice transport is used.
// Mirrors create_transport() in agent/src/smiledesk/voice/pipeline.py. Daily arrives with deployment (M6).
export type VoiceTransportKind = "smallwebrtc" | "daily";

interface VoiceConfig {
  transport: VoiceTransportKind;
  ice_servers: RTCIceServer[];
  max_session_seconds: number;
  active_sessions: number;
  max_sessions: number;
  daily_limit_reached?: boolean;
  resting_message?: string;
}

export async function getVoiceConfig(): Promise<VoiceConfig> {
  const res = await fetch(`${AGENT_URL}/api/voice/config`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Voice config failed (${res.status})`);
  return (await res.json()) as VoiceConfig;
}

export function createVoiceClient(config: VoiceConfig, callbacks: Partial<RTVIEventCallbacks>): PipecatClient {
  if (config.transport !== "smallwebrtc") {
    throw new Error(`Voice transport "${config.transport}" isn't supported by this build yet.`);
  }
  const transport = new SmallWebRTCTransport({ iceServers: config.ice_servers.length ? config.ice_servers : undefined });
  return new PipecatClient({ transport, enableMic: true, enableCam: false, callbacks });
}

/** Starts the call. With a conversation id, Pearl continues that conversation (e.g. switching from chat to voice). */
export async function connectVoice(client: PipecatClient, persona: string | null, conversationId: string | null = null): Promise<void> {
  await client.connect({
    webrtcRequestParams: { endpoint: `${AGENT_URL}/api/offer`, requestData: { persona, conversation_id: conversationId } },
  });
}

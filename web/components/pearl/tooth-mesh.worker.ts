// Builds Pearl's body mesh off the main thread (a few hundred ms of maths on slow phones).
import { buildToothMesh } from "./tooth-sdf";

self.onmessage = (e: MessageEvent<{ resolution?: number }>) => {
  const mesh = buildToothMesh(e.data?.resolution);
  (self as unknown as Worker).postMessage(mesh, [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer]);
};

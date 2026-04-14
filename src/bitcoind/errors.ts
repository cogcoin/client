function appendNextStep(message: string, nextStep: string): string {
  if (message.includes("Next:")) {
    return message;
  }

  return `${message} Next: ${nextStep}`;
}

export function formatManagedSyncErrorMessage(message: string): string {
  if (message === "bitcoind_no_peers_for_header_sync_check_internet_or_firewall") {
    return appendNextStep(
      "No Bitcoin peers were available for header sync.",
      "Check your internet access and firewall rules for outbound Bitcoin connections, then rerun sync.",
    );
  }

  if (message.startsWith("snapshot download failed from ")) {
    const detail = message.slice("snapshot download failed from ".length);
    return appendNextStep(
      `The snapshot download failed from ${detail}.`,
      "Check your internet connection, DNS, firewall, or VPN access to the snapshot host, then rerun sync.",
    );
  }

  if (message.startsWith("snapshot_http_")) {
    return appendNextStep(
      `Snapshot server request failed (${message.replace("snapshot_http_", "HTTP ")}).`,
      "Wait a moment, confirm the snapshot host is reachable, then rerun sync.",
    );
  }

  if (message === "snapshot_response_body_missing") {
    return appendNextStep(
      "Snapshot server returned an empty response body.",
      "Wait a moment, confirm the snapshot host is reachable, then rerun sync.",
    );
  }

  if (message === "snapshot_resume_requires_partial_content") {
    return appendNextStep(
      "Snapshot server ignored the resume request for a partial download.",
      "Wait a moment and rerun sync. If this keeps happening, confirm the snapshot host supports HTTP range requests.",
    );
  }

  if (message.startsWith("snapshot_chunk_sha256_mismatch_")) {
    return appendNextStep(
      "A downloaded snapshot chunk was corrupted and was rolled back to the last verified checkpoint.",
      "Wait a moment and rerun sync. If this keeps happening, check local disk health and the stability of the snapshot connection.",
    );
  }

  if (message.startsWith("snapshot_download_incomplete_")) {
    return appendNextStep(
      "Snapshot download ended before the expected file size was reached.",
      "Wait a moment and rerun sync. The downloader will resume from the last verified checkpoint.",
    );
  }

  if (message === "bitcoind_cookie_timeout") {
    return appendNextStep(
      "The managed Bitcoin node did not finish starting in time.",
      "Check the node logs and local permissions for the Bitcoin data directory, then rerun sync.",
    );
  }

  if (message === "bitcoind_rpc_timeout") {
    return appendNextStep(
      "The managed Bitcoin RPC service did not become ready in time.",
      "Check the node logs and confirm the local RPC port is not blocked, then rerun sync.",
    );
  }

  if (message.startsWith("The managed Bitcoin RPC cookie file is unavailable at ")) {
    return appendNextStep(
      "The managed Bitcoin node is not running or is already shutting down.",
      "If you were exiting cleanly, this is safe to ignore. Otherwise, start follow or rerun sync to start the managed node again.",
    );
  }

  if (message.startsWith("The managed Bitcoin RPC cookie file could not be read at ")) {
    return appendNextStep(
      message,
      "Check the managed Bitcoin data directory permissions and confirm the node is still running, then retry.",
    );
  }

  if (message.startsWith("bitcoind_rpc_http_")) {
    return appendNextStep(
      `The managed Bitcoin RPC service returned ${message.replace("bitcoind_rpc_http_", "HTTP ")}.`,
      "Check the local node logs and confirm the managed RPC endpoint is reachable, then rerun sync.",
    );
  }

  if (message.startsWith("The managed Bitcoin RPC request to ")) {
    const nextStep = message.includes("for loadtxoutset failed")
      ? "Wait a moment and rerun sync. If this keeps happening, inspect the local Bitcoin debug log and check local firewall or security software that could interrupt localhost RPC connections."
      : "Check the local node logs and confirm the managed RPC endpoint is reachable, then rerun sync.";

    return appendNextStep(message, nextStep);
  }

  if (message.startsWith("bitcoind_chain_expected_")) {
    return appendNextStep(
      "The managed Bitcoin node started on the wrong chain.",
      "Check the managed node configuration and data directory, then rerun sync.",
    );
  }

  if (message === "bitcoind_version_unsupported") {
    return appendNextStep(
      "The managed Bitcoin Core version is unsupported.",
      "Install the supported Bitcoin Core version and rerun sync.",
    );
  }

  return message;
}

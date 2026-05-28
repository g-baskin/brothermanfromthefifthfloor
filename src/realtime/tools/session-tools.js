/**
 * Session-control tools. These affect the live Realtime call rather than data or
 * the OS. The actual call teardown happens in the renderer (which owns the
 * WebRTC peer); this handler returns the model-visible acknowledgment and is the
 * fallback when the tool is dispatched through the main-process IPC path.
 *
 * @param {string} name Tool name.
 * @param {object} args Tool arguments.
 * @returns {Promise<object|null>} Result for a session tool, or null otherwise.
 */
export async function executeSessionTool(name, args = {}, options = {}) {
  if (name === "end_call") {
    const reason =
      typeof args?.reason === "string" && args.reason.trim()
        ? args.reason.trim().slice(0, 120)
        : undefined;
    return {
      status: "call_ended",
      message: "Ending the call. Goodbye.",
      ...(reason ? { reason } : {}),
    };
  }
  if (name === "cancel_computer_use") {
    const result = await options.cancelComputerUse?.();
    const cancelled = result?.cancelled === true;
    return {
      status: cancelled ? "cancelled" : "idle",
      message: cancelled ? "Computer use stopped." : "No computer-use task is running.",
    };
  }
  return null;
}

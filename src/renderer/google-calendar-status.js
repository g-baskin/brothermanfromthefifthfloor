const KNOWN_STATES = new Set(["unconfigured", "disconnected", "connected", "connecting", "error"]);

export function createGoogleCalendarStatusView(status = {}, formatDate = defaultFormatDate) {
  const state = KNOWN_STATES.has(status.state) ? status.state : "error";
  const labels = {
    unconfigured: "Not configured",
    disconnected: "Disconnected",
    connected: "Connected",
    connecting: "Connecting…",
    error: "Needs attention",
  };
  const messages = {
    unconfigured: "Set BRAH_GOOGLE_OAUTH_CLIENT_ID to enable Google Calendar.",
    disconnected: "Brah can manage events on calendars you own after you connect.",
    connected: status.connectedAt
      ? `Connected since ${formatDate(status.connectedAt)}. Brah can manage owned-calendar events.`
      : "Connected. Brah can manage events on calendars you own.",
    connecting: "Finish authorization in your system browser.",
    error: status.message || "Google Calendar needs attention. Try connecting again.",
  };

  return {
    state,
    label: labels[state],
    message: status.message || messages[state],
    connectDisabled: state === "connecting" || state === "unconfigured",
    connectLabel:
      state === "connecting" ? "Connecting…" : state === "connected" ? "Reconnect" : "Connect",
    disconnectHidden: state !== "connected",
    disconnectDisabled: state === "connecting",
  };
}

export async function connectAndRefreshGoogleCalendar(api, onStatus) {
  onStatus({ state: "connecting" });
  const result = await api.connectGoogleCalendar();
  if (result?.state !== "connected") {
    onStatus(result);
    return result;
  }
  const confirmedStatus = await api.getGoogleCalendarStatus();
  onStatus(confirmedStatus);
  return confirmedStatus;
}

function defaultFormatDate(value) {
  return new Date(value).toLocaleDateString();
}

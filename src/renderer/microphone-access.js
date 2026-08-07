const permissionErrorNames = new Set(["NotAllowedError", "SecurityError"]);

export async function acquireMicrophoneWithPermission({
  getPermissions,
  requestPermission,
  acquireStream,
  openSettings,
  onPermissionStatus = async () => {},
  onPermissionResult = async () => {},
  onAcquisitionError = async () => {},
  onPrompt = () => {},
}) {
  const permissions = await getPermissions();
  const microphone = permissions.find((permission) => permission.id === "microphone");
  await onPermissionStatus(microphone?.status ?? "missing");

  // Native macOS permission state can remain stale after Brah is enabled in
  // System Settings. Only trigger the native prompt for a first-time decision;
  // actual Chromium capture below is the final authority.
  if (microphone?.status === "not-determined") {
    onPrompt();
    const updatedPermissions = await requestPermission();
    const updatedMicrophone = updatedPermissions.find(
      (permission) => permission.id === "microphone",
    );
    await onPermissionResult(updatedMicrophone?.status ?? "missing");
  }

  try {
    return await acquireStream();
  } catch (error) {
    await onAcquisitionError(error);
    if (permissionErrorNames.has(error?.name)) {
      await openSettings();
      throw new Error(
        "Microphone access is required. Allow Brah/Electron in System Settings → Privacy & Security → Microphone, then try again.",
        { cause: error },
      );
    }
    throw error;
  }
}

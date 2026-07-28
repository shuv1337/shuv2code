import { useClerk } from "@clerk/react";

export function useShuv2CodeConnectAuthPrompt() {
  const clerk = useClerk();
  const openAuthPrompt = () => {
    clerk.openWaitlist();
  };
  return { authPrompt: null, openAuthPrompt };
}

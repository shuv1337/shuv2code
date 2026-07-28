import { UserButton, useAuth } from "@clerk/react";
import { LogInIcon, SmartphoneIcon } from "lucide-react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { useShuv2CodeConnectAuthPrompt } from "./useShuv2CodeConnectAuthPrompt";

export function Shuv2CodeConnectSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredShuv2CodeConnectSidebarSignIn />;
}

export function Shuv2CodeConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredShuv2CodeConnectSidebarAvatar />;
}

function ConfiguredShuv2CodeConnectSidebarAvatar() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded || !isSignedIn) return null;

  return (
    <UserButton
      appearance={{
        elements: {
          avatarBox: "size-7",
          userButtonTrigger: "rounded-lg p-1 hover:bg-sidebar-row-hover",
        },
      }}
    >
      <UserButton.UserProfilePage
        label="Mobile clients"
        labelIcon={<SmartphoneIcon className="size-4" />}
        url="mobile-clients"
      >
        <MobileClientsUserProfilePage />
      </UserButton.UserProfilePage>
    </UserButton>
  );
}

function ConfiguredShuv2CodeConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const { authPrompt, openAuthPrompt } = useShuv2CodeConnectAuthPrompt();

  if (!isLoaded || isSignedIn) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            className="h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            onClick={openAuthPrompt}
          >
            <LogInIcon className="size-4 shrink-0" />
            <span>Sign in to shuv2code connect</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {authPrompt}
    </>
  );
}

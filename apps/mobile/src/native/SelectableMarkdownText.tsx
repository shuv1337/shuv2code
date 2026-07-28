import type { SelectableMarkdownTextProps } from "@shuv2code/mobile-markdown-text/renderer";

type MobileSelectableMarkdownTextProps = Omit<SelectableMarkdownTextProps, "highlightCode">;

export type {
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@shuv2code/mobile-markdown-text/types";

export function hasNativeSelectableMarkdownText(): boolean {
  return false;
}

export function SelectableMarkdownText(_props: MobileSelectableMarkdownTextProps) {
  return null;
}

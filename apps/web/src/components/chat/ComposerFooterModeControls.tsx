import { useSideChatPortalProps } from "./sideChatFocus";
import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo } from "react";
import {
  BotIcon,
  PencilRulerIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import {
  ComposerControl,
  ComposerControlIcon,
  ComposerControlSeparator,
  ComposerSelectControl,
} from "./ComposerControl";
import { composerFloatingLayerProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};

const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];
export const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  showInteractionModeToggle: boolean;
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  size?: "sm" | "xs";
  hidden?: boolean;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const sideChatPortalProps = useSideChatPortalProps();
  const size = props.size ?? "sm";
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const runtimeModeOption = runtimeModeConfig[props.runtimeMode];
  const RuntimeModeIcon = runtimeModeOption.icon;
  const interactionModeTooltip =
    props.interactionMode === "plan"
      ? "Plan mode — click to return to normal build mode"
      : "Default mode — click to enter plan mode";

  const interactionModeToggle = props.showInteractionModeToggle ? (
    <>
      <ComposerControlSeparator size={size} />
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              size={size}
              className={cn(
                "shrink-0 whitespace-nowrap",
                props.interactionMode === "plan"
                  ? "bg-accent text-accent-foreground hover:bg-accent/80"
                  : size === "xs"
                    ? undefined
                    : "text-secondary-label hover:text-foreground",
              )}
              type="button"
              onClick={props.onToggleInteractionMode}
              aria-label={interactionModeTooltip}
            />
          }
        >
          {props.interactionMode === "plan" ? (
            <ComposerControlIcon
              icon={PencilRulerIcon}
              size={size}
              className="text-current opacity-100"
            />
          ) : (
            <ComposerControlIcon
              icon={BotIcon}
              size={size}
              opticalSize={size === "xs" ? "default" : "large"}
            />
          )}
          <span className="sr-only sm:not-sr-only">
            {props.interactionMode === "plan" ? "Plan" : "Build"}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{interactionModeTooltip}</TooltipPopup>
      </Tooltip>
    </>
  ) : null;

  return (
    <>
      <ComposerControlSeparator size={size} />

      <Tooltip>
        <Select
          open={open}
          onOpenChange={setOpen}
          value={props.runtimeMode}
          onValueChange={(value) => props.onRuntimeModeChange(value!)}
        >
          <TooltipTrigger
            render={
              <ComposerSelectControl
                size={size}
                className={size === "xs" ? undefined : "font-medium"}
                aria-label="Runtime mode"
              />
            }
          >
            <ComposerControlIcon icon={RuntimeModeIcon} size={size} />
            <SelectValue>{runtimeModeOption.label}</SelectValue>
          </TooltipTrigger>
          <SelectPopup
            {...sideChatPortalProps}
            alignItemWithTrigger={false}
            {...composerFloatingLayerProps}
          >
            {runtimeModeOptions.map((mode) => {
              const option = runtimeModeConfig[mode];
              const OptionIcon = option.icon;
              return (
                <SelectItem key={mode} value={mode} hideIndicator className="min-w-64 py-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                        <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        {option.label}
                      </span>
                      <span className="text-muted-foreground text-xs leading-4">
                        {option.description}
                      </span>
                    </div>
                  </div>
                </SelectItem>
              );
            })}
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">{runtimeModeOption.description}</TooltipPopup>
      </Tooltip>

      {interactionModeToggle}
    </>
  );
});

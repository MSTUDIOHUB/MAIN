import { forwardRef, type ButtonHTMLAttributes } from "react";
import "./ToggleSwitch.css";

export interface ToggleSwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onChange" | "onClick" | "role" | "type" | "aria-checked"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/** One binary setting control. Native button semantics provide Space/Enter
 * activation; labels and descriptions stay owned by the surrounding setting. */
const ToggleSwitch = forwardRef<HTMLButtonElement, ToggleSwitchProps>(function ToggleSwitch(
  { checked, onCheckedChange, disabled, className = "", ...props }, ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`main-toggle-switch ${className}`.trim()}
      onClick={() => { if (!disabled) onCheckedChange(!checked); }}
    >
      <span className="main-toggle-switch__thumb" aria-hidden="true" />
    </button>
  );
});

export default ToggleSwitch;

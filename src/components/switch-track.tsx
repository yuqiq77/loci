// The look of every on/off switch: a pill with a round knob inset on all
// sides. The caller owns the control (a checkbox, a menu item) and its label.
export function SwitchTrack({
  on,
  className = "",
}: {
  on: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex h-[26px] w-[46px] shrink-0 items-center rounded-full shadow-[inset_0_1px_2px_rgba(36,33,29,0.12)] transition-colors duration-200 ${
        on ? "bg-switch-on" : "bg-stone-300/80"
      } ${className}`}
    >
      <span
        className={`absolute left-[3px] size-5 rounded-full bg-white shadow-[0_1px_2px_rgba(36,33,29,0.18),0_2px_6px_rgba(36,33,29,0.12)] transition-transform duration-200 ease-[cubic-bezier(0.34,1.3,0.64,1)] ${
          on ? "translate-x-5" : ""
        }`}
      />
    </span>
  );
}

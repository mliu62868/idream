import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function HeartOutlineIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12.001 4.529C14.35 2.42 17.98 2.49 20.243 4.757c2.262 2.267 2.34 5.88.236 8.236L12 21.485l-8.479-8.492C1.417 10.637 1.496 7.019 3.757 4.757c2.265-2.264 5.888-2.34 8.244-.228Zm6.826 1.641c-1.499-1.502-3.919-1.563-5.49-.153l-1.335 1.198-1.336-1.197C9.091 4.606 6.675 4.668 5.172 6.172c-1.49 1.489-1.565 3.875-.192 5.451L12 18.654l7.02-7.031c1.374-1.576 1.299-3.958-.193-5.453Z" />
    </svg>
  );
}

export function ChatBubbleIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M7.291 20.824 2 22l1.176-5.291A9.956 9.956 0 0 1 2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10a9.956 9.956 0 0 1-4.709-1.176Zm.29-2.113.653.35A7.963 7.963 0 0 0 12 20a8 8 0 1 0-8-8c0 1.334.325 2.618.939 3.766l.35.653-.655 2.947 2.947-.655Z" />
    </svg>
  );
}

export function SparkleBadgeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M14 4.438A2.438 2.438 0 0 0 16.438 2h1.125A2.438 2.438 0 0 0 20 4.438v1.124A2.438 2.438 0 0 0 17.563 8h-1.126A2.438 2.438 0 0 0 14 5.562V4.438ZM1 11a6 6 0 0 0 6-6h2a6 6 0 0 0 6 6v2a6 6 0 0 0-6 6H7a6 6 0 0 0-6-6v-2Zm16.25 3A3.75 3.75 0 0 1 14 17.25v1.5A3.75 3.75 0 0 1 17.25 22h1.5A3.75 3.75 0 0 1 22 18.75v-1.5A3.75 3.75 0 0 1 18.75 14h-1.5Z" />
    </svg>
  );
}

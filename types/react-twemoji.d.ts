declare module "react-twemoji" {
  import * as React from "react";

  export interface TwemojiProps {
    children?: React.ReactNode;
    noWrapper?: boolean;
    options?: Record<string, unknown>;
  }

  const Twemoji: React.ComponentType<TwemojiProps>;
  export default Twemoji;
}
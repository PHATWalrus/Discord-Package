/* eslint-disable no-unexpected-multiline */
/* eslint-disable no-mixed-spaces-and-tabs */
import React, { ReactElement } from "react";
import { SnackbarProvider } from "notistack";
import { dataAtom } from "./atoms/demo";
import { useAtom } from "jotai";
import dynamic from "next/dynamic";
import { Suspense } from "react";
import Loading from "./Loading";

export default function Upload(): ReactElement<any> {
  const [data] = useAtom(dataAtom);

  const DynamicComponent = dynamic<any>(
    () => import("./Data").then((module) => module.default as any),
    {
    ssr: true,
    loading: () => <Loading skeleton={true} />,
    }
  );

  return data ? (
    <Suspense fallback={<Loading skeleton={true} />}>
      {React.createElement(SnackbarProvider as any, null,
        React.createElement(DynamicComponent as any, {
          data,
          demo: true,
        })
      )}
    </Suspense>
  ) : (
    <></>
  );
}

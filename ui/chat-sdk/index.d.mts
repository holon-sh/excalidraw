// holon-generated-apps-v1 app=excalidraw-typed-chat.5pY7zn
import type { ToolClient, EndpointBinding, CreateOptions } from "holon-ui/runtime";
export { ToolCallError } from "holon-ui/runtime";
export type ExcalidrawChatOutputBoardUrlId = { "boardUrl": string; "id": string; };
export type ExcalidrawChatOutputAccepted = { "accepted": true; };
export interface Inputs {
  "excalidraw-chat": {
    "create_room": {  };
    "read_board_chat": { "board": string; };
    "read_room": { "room": string; };
    "send_board_message": { "board": string; "id": string; "text": string; };
    "send_message": { "id": string; "room": string; "text": string; };
  };
}
export interface Outputs {
  "excalidraw-chat": {
    "create_room": { "room": ExcalidrawChatOutputBoardUrlId; };
    "read_board_chat": { "messages": Array<{ "at": string; "author": string; "elementIds": Array<string>; "kind": ("human" | "agent" | "error"); "mine": boolean; "seq": number; "text": string; }>; "pending": boolean; "viewer": (string | null); };
    "read_room": { "messages": Array<{ "at": string; "author": string; "kind": ("human" | "agent" | "error"); "mine": boolean; "seq": number; "text": string; }>; "pending": boolean; "room": ExcalidrawChatOutputBoardUrlId; "viewer": string; };
    "send_board_message": ExcalidrawChatOutputAccepted;
    "send_message": ExcalidrawChatOutputAccepted;
  };
}
export interface InputTypes {
  "excalidraw-chat": {
    "create_room": {  };
    "read_board_chat": {  };
    "read_room": {  };
    "send_board_message": {  };
    "send_message": {  };
  };
}
export interface OutputTypes {
  "excalidraw-chat": {
    "create_room": {  };
    "read_board_chat": {  };
    "read_room": {  };
    "send_board_message": {  };
    "send_message": {  };
  };
}
export interface Resources {
  "excalidraw-chat": {
    "ui://page": unknown;
  };
}
export interface EventArguments {
  "excalidraw-chat": {
  };
}
export interface EventData {
  "excalidraw-chat": {
  };
}
export type Events = { readonly [A in keyof EventArguments]: { [K in keyof EventArguments[A]]: { arguments: EventArguments[A][K]; data: K extends keyof EventData[A] ? EventData[A][K] : unknown } } };

export type Apps = { readonly [A in keyof Inputs]: ToolClient<Inputs[A], Outputs[A], Resources[A], Events[A]> };
export type { EndpointBinding, CreateOptions };
export declare function createApps<K extends keyof Apps>(bindings: { [A in K]: EndpointBinding }, options?: CreateOptions): Pick<Apps,K>;

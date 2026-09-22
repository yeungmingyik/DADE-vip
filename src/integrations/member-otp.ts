import { requireDemoMode } from "./demo";

export interface OtpDeliveryInput {
  phone: string;
  code: string;
  expiresAt: string;
}

export interface OtpDeliveryResult {
  demoCode?: string;
}

export interface OtpDelivery {
  send(input: OtpDeliveryInput): Promise<OtpDeliveryResult>;
}

export class DemoOtpDelivery implements OtpDelivery {
  async send(input: OtpDeliveryInput): Promise<OtpDeliveryResult> {
    requireDemoMode();
    return { demoCode: input.code };
  }
}

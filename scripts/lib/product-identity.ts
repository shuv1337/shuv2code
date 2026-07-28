import brand from "../../brand/shuv2code.brand.json" with { type: "json" };

export const PRODUCT_IDENTITY = brand;

export type ProductChannel = keyof typeof PRODUCT_IDENTITY.channels;

export const productApplicationId = (channel: ProductChannel): string =>
  PRODUCT_IDENTITY.applicationIds[channel];

export const productScheme = (channel: ProductChannel): string => PRODUCT_IDENTITY.schemes[channel];

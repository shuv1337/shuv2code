export type Tweet = {
  handle: string;
  content: string;
  excerpt?: string;
  link: string;
};

export const tweets: Tweet[] = [];

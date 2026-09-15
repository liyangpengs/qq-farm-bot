export {};
export interface Account {
  id: string;
  name: string;
  code: string;
  platform: string;
  uin: string;
  qq: string;
  avatar: string;
  nick?: string;
  username?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AccountsData {
  accounts: Account[];
  nextId: number;
}

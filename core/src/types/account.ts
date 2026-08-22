export {};
export interface Account {
  id: string;
  name: string;
  code: string;
  loginBuffer: string;
  platform: string;
  uin: string;
  qq: string;
  avatar: string;
  owner: string;
  nick?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AccountsData {
  accounts: Account[];
  nextId: number;
}

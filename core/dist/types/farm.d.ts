export {};
export type PlantPhase = 'empty' | 'seed' | 'sprout' | 'growing' | 'mature' | 'harvestable' | 'withered';
export type LandType = 'normal' | 'gold' | 'black' | 'red' | 'purple-gold';
export interface LandData {
    landId: number;
    plantId: number;
    plantPhase: PlantPhase;
    waterTime: number;
    fertilizerTime: number;
    harvestTime: number;
    landLevel: number;
    landType: LandType;
    status: number;
}
export interface FarmStatus {
    lands: LandData[];
    harvestCount: number;
    waterCount: number;
    weedCount: number;
    insectCount: number;
}
export interface SeedInfo {
    seedId: number;
    name: string;
    level: number;
    exp: number;
    price: number;
    growTime: number;
    harvestCount: number;
}
export interface ShopItem {
    goodsId: number;
    name: string;
    price: number;
    type: number;
}
export interface BagItem {
    itemId: number;
    count: number;
    name: string;
    type: number;
}
//# sourceMappingURL=farm.d.ts.map
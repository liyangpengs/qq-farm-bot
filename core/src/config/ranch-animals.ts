import animals from '../gameConfig/ranch/MCAnimalConfig.json';
import mutations from '../gameConfig/ranch/MCAnimalMutation.json';

export const animalMap = new Map(animals.map(row => [row.id, row]));
export const cubMap = new Map([
    ...animals.map(row => [row.cub_item_id, { ...row, giantCubItemId: 0 }] as const),
    ...mutations.map(row => [row.giant_cub_item_id, { ...animalMap.get(row.animal_id)!, giantCubItemId: row.giant_cub_item_id }] as const),
]);

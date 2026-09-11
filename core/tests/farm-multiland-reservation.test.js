const assert = require('node:assert/strict');
const test = require('node:test');

const {
    selectFutureLayoutReservation,
} = require('../dist/services/farm/layout-reservation');

test('reserves the earliest stable 2x2 layout for a priority seed', () => {
    const reservation = selectFutureLayoutReservation(
        [1, 2, 3],
        Array.from({ length: 15 }, (_, index) => index + 1),
        2,
    );

    assert.deepEqual(reservation, {
        layout: { anchorLandId: 5, landIds: [5, 6, 1, 2] },
        reservedLandIds: [1, 2],
    });
});

test('keeps accumulating empty lands in the selected future layout', () => {
    const reservation = selectFutureLayoutReservation(
        [1, 2, 5],
        Array.from({ length: 15 }, (_, index) => index + 1),
        2,
    );

    assert.deepEqual(reservation, {
        layout: { anchorLandId: 5, landIds: [5, 6, 1, 2] },
        reservedLandIds: [5, 1, 2],
    });
});

test('prefers the earliest partial layout over a fuller later layout to avoid oscillation', () => {
    const reservation = selectFutureLayoutReservation(
        [1, 3, 4, 7],
        Array.from({ length: 15 }, (_, index) => index + 1),
        2,
    );

    assert.deepEqual(reservation, {
        layout: { anchorLandId: 5, landIds: [5, 6, 1, 2] },
        reservedLandIds: [1],
    });
});

test('does not reserve when the multi-land layout is already plantable', () => {
    const reservation = selectFutureLayoutReservation(
        [1, 2, 5, 6],
        Array.from({ length: 15 }, (_, index) => index + 1),
        2,
    );

    assert.equal(reservation, null);
});

test('does not reserve single-land crops or impossible future layouts', () => {
    assert.equal(selectFutureLayoutReservation([1], [1, 2, 5, 6], 1), null);
    assert.equal(selectFutureLayoutReservation([1, 2, 3], [1, 2, 3, 4], 2), null);
});

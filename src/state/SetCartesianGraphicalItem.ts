import { useEffect } from 'react';
import { useAppDispatch } from './hooks';
import {
  addCartesianGraphicalItem,
  CartesianGraphicalItemSettings,
  removeCartesianGraphicalItem,
} from './graphicalItemsSlice';

export function SetCartesianGraphicalItem({
  data,
  dataKey,
  hide,
  stackId,
  xAxisId,
  yAxisId,
  errorBars,
}: CartesianGraphicalItemSettings): null {
  const dispatch = useAppDispatch();
  useEffect(() => {
    dispatch(addCartesianGraphicalItem({ data, dataKey, hide, stackId, xAxisId, yAxisId, errorBars }));
    return () => {
      dispatch(removeCartesianGraphicalItem({ data, dataKey, hide, stackId, xAxisId, yAxisId, errorBars }));
    };
  }, [dispatch, data, dataKey, hide, stackId, xAxisId, yAxisId, errorBars]);
  return null;
}

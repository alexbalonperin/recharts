import React, { PureComponent, ReactElement, Ref, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Animate from 'react-smooth';
import isFunction from 'lodash/isFunction';
import isNil from 'lodash/isNil';

import clsx from 'clsx';
import { XAxisWithExtraData, YAxisWithExtraData } from '../chart/types';
import { selectChartLayout, selectChartOffset, useXAxisOrThrow, useYAxisOrThrow } from '../context/chartLayoutContext';
import { useAppSelector } from '../state/hooks';
import { selectDisplayedData } from '../state/axisSelectors';
import { Curve, CurveType, Point as CurvePoint, Props as CurveProps } from '../shape/Curve';
import { Dot } from '../shape/Dot';
import { Layer } from '../container/Layer';
import { ImplicitLabelType } from '../component/Label';
import { LabelList } from '../component/LabelList';
import { ErrorBar, ErrorBarDataPointFormatter, Props as ErrorBarProps } from './ErrorBar';
import { interpolateNumber, uniqueId } from '../util/DataUtils';
import { filterProps, findAllByType, hasClipDot } from '../util/ReactUtils';
import { Global } from '../util/Global';
import {
  getBandSizeOfAxis,
  getCateCoordinateOfLine,
  getTicksOfAxis,
  getTooltipNameProp,
  getValueByDataKey,
} from '../util/ChartUtils';
import { ActiveDotType, AnimationDuration, AnimationTiming, DataKey, LegendType, TooltipType } from '../util/types';
import type { Payload as LegendPayload } from '../component/DefaultLegendContent';
import { useLegendPayloadDispatch } from '../context/legendPayloadContext';
import { ActivePoints } from '../component/ActivePoints';
import { TooltipPayloadConfiguration } from '../state/tooltipSlice';
import { SetTooltipEntrySettings } from '../state/SetTooltipEntrySettings';
import { SetCartesianGraphicalItem } from '../state/SetCartesianGraphicalItem';
import { CartesianGraphicalItemContext } from '../context/CartesianGraphicalItemContext';

export interface LinePointItem extends CurvePoint {
  value?: number;
  payload?: any;
}

/**
 * No more cloning = no more internal only props
 */
interface InternalLineProps {
  // top?: number;
  // left?: number;
  // width?: number;
  // height?: number;
  // points stays because its an override
  points?: LinePointItem[];
  // xAxis?: Omit<XAxisProps, 'scale'> & { scale: D3Scale<string | number> };
  // yAxis?: Omit<YAxisProps, 'scale'> & { scale: D3Scale<string | number> };
}

interface LineProps extends InternalLineProps {
  className?: string;
  data?: any;
  type?: CurveType;
  unit?: string | number;
  name?: string | number;
  yAxisId?: string | number;
  xAxisId?: string | number;
  dataKey?: DataKey<any>;
  legendType?: LegendType;
  tooltipType?: TooltipType;
  connectNulls?: boolean;
  hide?: boolean;

  activeDot?: ActiveDotType;
  dot?: ActiveDotType;

  onAnimationStart?: () => void;
  onAnimationEnd?: () => void;

  isAnimationActive?: boolean;
  animateNewValues?: boolean;
  animationBegin?: number;
  animationDuration?: AnimationDuration;
  animationEasing?: AnimationTiming;
  animationId?: number;
  id?: string;
  label?: ImplicitLabelType;
}

export type Props = Omit<CurveProps, 'points' | 'pathRef'> & LineProps;

interface State {
  isAnimationFinished?: boolean;
  totalLength?: number;
  prevPoints?: LinePointItem[];
  curPoints?: LinePointItem[];
  prevAnimationId?: number;
}

const computeLegendPayloadFromAreaData = (props: Props): Array<LegendPayload> => {
  const { dataKey, name, stroke, legendType, hide } = props;
  return [
    {
      inactive: hide,
      dataKey,
      type: legendType,
      color: stroke,
      value: name || dataKey,
      payload: props,
    },
  ];
};

function SetLineLegend(props: Props): null {
  useLegendPayloadDispatch(computeLegendPayloadFromAreaData, props);
  return null;
}

function getTooltipEntrySettings(props: Props): TooltipPayloadConfiguration {
  const { dataKey, data, stroke, strokeWidth, fill, name, hide, unit } = props;
  return {
    dataDefinedOnItem: data,
    settings: {
      stroke,
      strokeWidth,
      fill,
      dataKey,
      nameKey: undefined,
      name: getTooltipNameProp(name, dataKey),
      hide,
      type: props.tooltipType,
      color: props.stroke,
      unit,
    },
  };
}

const noErrorBars: never[] = [];

const repeat = (lines: number[], count: number) => {
  const linesUnit = lines.length % 2 !== 0 ? [...lines, 0] : lines;
  let result: number[] = [];

  for (let i = 0; i < count; ++i) {
    result = [...result, ...linesUnit];
  }

  return result;
};

const generateSimpleStrokeDasharray = (totalLength: number, length: number): string => {
  return `${length}px ${totalLength - length}px`;
};

const getStrokeDasharray = (length: number, totalLength: number, lines: number[]) => {
  const lineLength = lines.reduce((pre, next) => pre + next);

  // if lineLength is 0 return the default when no strokeDasharray is provided
  if (!lineLength) {
    return generateSimpleStrokeDasharray(totalLength, length);
  }

  const count = Math.floor(length / lineLength);
  const remainLength = length % lineLength;
  const restLength = totalLength - length;

  let remainLines: number[] = [];
  for (let i = 0, sum = 0; i < lines.length; sum += lines[i], ++i) {
    if (sum + lines[i] > remainLength) {
      remainLines = [...lines.slice(0, i), remainLength - sum];
      break;
    }
  }

  const emptyLines = remainLines.length % 2 === 0 ? [0, restLength] : [restLength];

  return [...repeat(lines, count), ...remainLines, ...emptyLines].map(line => `${line}px`).join(', ');
};

const StaticCurve = ({
  lineProps,
  points,
  needClip,
  clipPathId,
  pathRef,
  curveOptions,
}: {
  lineProps: Props;
  points: LinePointItem[];
  needClip: boolean;
  clipPathId: string;
  pathRef: Ref<SVGPathElement>;
  curveOptions?: { strokeDasharray: string };
}) => {
  const layout = useAppSelector(selectChartLayout);
  const { type, connectNulls, ref, ...others } = lineProps;
  const curveProps = {
    ...filterProps(others, true),
    fill: 'none',
    className: 'recharts-line-curve',
    clipPath: needClip ? `url(#clipPath-${clipPathId})` : null,
    points,
    ...curveOptions,
    type,
    layout,
    connectNulls,
  };

  return <Curve {...curveProps} pathRef={pathRef} />;
};

const AnimatedCurve = ({
  lineProps,
  prevPoints,
  currentPoints,
  needClip,
  clipPathId,
  totalLength,
  pathRef,
  handleAnimationStart,
  handleAnimationEnd,
}: {
  lineProps: Props;
  currentPoints: LinePointItem[];
  prevPoints: LinePointItem[] | null;
  totalLength: number;
  needClip: boolean;
  clipPathId: string;
  pathRef: Ref<SVGPathElement>;
  handleAnimationStart: () => void;
  handleAnimationEnd: () => void;
}) => {
  const { height, width } = useAppSelector(selectChartOffset);
  const {
    strokeDasharray,
    isAnimationActive,
    animationBegin,
    animationDuration,
    animationEasing,
    // TODO: animationId is now always undefined - previously it was always updateId from generateCategoricalChart
    // Determine if this is needed or if we can just remove `key` altogether.
    animationId,
    animateNewValues,
  } = lineProps;

  return (
    <Animate
      begin={animationBegin}
      duration={animationDuration}
      isActive={isAnimationActive}
      easing={animationEasing}
      from={{ t: 0 }}
      to={{ t: 1 }}
      key={`line-${animationId}`}
      onAnimationEnd={handleAnimationEnd}
      onAnimationStart={handleAnimationStart}
    >
      {({ t }: { t: number }) => {
        // this breaks animation. Do we even need to store previous state? Seems to animate fine without doing so.
        // do we need anything in the if statement? Seems to be a lot there for no usage...
        // if (prevPoints)
        if (undefined) {
          const prevPointsDiffFactor = prevPoints.length / currentPoints.length;
          const stepData = currentPoints.map((entry, index) => {
            const prevPointIndex = Math.floor(index * prevPointsDiffFactor);
            if (prevPoints[prevPointIndex]) {
              const prev = prevPoints[prevPointIndex];
              const interpolatorX = interpolateNumber(prev.x, entry.x);
              const interpolatorY = interpolateNumber(prev.y, entry.y);

              return { ...entry, x: interpolatorX(t), y: interpolatorY(t) };
            }

            // magic number of faking previous x and y location
            if (animateNewValues) {
              const interpolatorX = interpolateNumber(width * 2, entry.x);
              const interpolatorY = interpolateNumber(height / 2, entry.y);
              return { ...entry, x: interpolatorX(t), y: interpolatorY(t) };
            }
            return { ...entry, x: entry.x, y: entry.y };
          });
          return (
            <StaticCurve
              lineProps={lineProps}
              points={stepData}
              needClip={needClip}
              clipPathId={clipPathId}
              pathRef={pathRef}
            />
          );
        }
        const interpolator = interpolateNumber(0, totalLength);
        const curLength = interpolator(t);
        let currentStrokeDasharray;

        // when a strokeDasharry is set there is sometimes issues when animating where you can see the end of the line before it finishes
        // TODO: investigate and fix
        if (strokeDasharray) {
          const lines = `${strokeDasharray}`.split(/[,\s]+/gim).map(num => parseFloat(num));
          currentStrokeDasharray = getStrokeDasharray(curLength, totalLength, lines);
        } else {
          currentStrokeDasharray = generateSimpleStrokeDasharray(totalLength, curLength);
        }

        return (
          <StaticCurve
            lineProps={lineProps}
            points={currentPoints}
            needClip={needClip}
            clipPathId={clipPathId}
            curveOptions={{
              strokeDasharray: currentStrokeDasharray,
            }}
            pathRef={pathRef}
          />
        );
      }}
    </Animate>
  );
};

const renderDotItem = (option: ActiveDotType, dotProps: any) => {
  let dotItem;

  if (React.isValidElement(option)) {
    dotItem = React.cloneElement(option, dotProps);
  } else if (isFunction(option)) {
    dotItem = option(dotProps);
  } else {
    const dotClassName = clsx('recharts-line-dot', typeof option !== 'boolean' ? option.className : '');
    dotItem = <Dot {...dotProps} className={dotClassName} />;
  }

  return dotItem;
};

// do we need this? Animation doesn't work with it...
const usePrevious = (value: any) => {
  const ref = useRef();
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
};

const useComposedLineData = (
  dataKey: DataKey<any>,
  xAxisId: string | number,
  yAxisId: string | number,
): { points: LinePointItem[]; prevPoints: LinePointItem[]; xAxis: XAxisWithExtraData; yAxis: YAxisWithExtraData } => {
  const layout = useAppSelector(selectChartLayout);

  // we should use matching axes rather than arbirary ones since we know the Line's axisIds.
  const matchingXAxis = useXAxisOrThrow(xAxisId);
  const matchingYAxis = useYAxisOrThrow(yAxisId);

  // if we don't throw we know the axisIds are good.
  const { tooltipAxis, tooltipAxisId } =
    layout === 'horizontal'
      ? { tooltipAxis: matchingXAxis, tooltipAxisId: xAxisId }
      : { tooltipAxis: matchingYAxis, tooltipAxisId: yAxisId };

  // we could select this from redux, but should we? Having matching axisIds is important in the graphical item.
  const tooltipTicks = getTicksOfAxis(tooltipAxis, false, true);

  // TODO: does Line even need this?
  const bandSize = getBandSizeOfAxis(tooltipAxis, tooltipTicks, false);

  const displayedData = useAppSelector(state => selectDisplayedData(state, tooltipAxis.axisType, tooltipAxisId));

  const points = displayedData.map((entry: Record<string, unknown>, index): LinePointItem => {
    const value = getValueByDataKey(entry, dataKey);

    if (layout === 'horizontal') {
      return {
        x: getCateCoordinateOfLine({ axis: tooltipAxis, ticks: tooltipTicks, bandSize, entry, index }),
        y: isNil(value) ? null : matchingYAxis?.scale(value),
        // @ts-expect-error unknown is not assignable to type number
        value,
        payload: entry,
      };
    }

    return {
      x: isNil(value) ? null : matchingXAxis?.scale(value),
      y: getCateCoordinateOfLine({ axis: tooltipAxis, ticks: tooltipTicks, bandSize, entry, index }),
      // @ts-expect-error unknown is not assignable to type number
      value,
      payload: entry,
    };
  });
  const prevPoints = usePrevious(points);

  return { points, prevPoints, xAxis: matchingXAxis, yAxis: matchingYAxis };
};

const LineWrapper = (props: Props & { id: string }) => {
  const { hide, dot, className, isAnimationActive, id, dataKey, yAxisId, xAxisId } = props;
  const [isAnimationFinished, setIsAnimationFinished] = useState(true);
  const [totalLength, setTotalLength] = useState(0);
  const { top, left, height, width } = useAppSelector(selectChartOffset);
  const layout = useAppSelector(selectChartLayout);

  const {
    points: calculatedPoints,
    prevPoints,
    xAxis,
    yAxis,
  } = useComposedLineData(dataKey, props.xAxisId, props.yAxisId);
  const points = props.points.length > 0 ? props.points : calculatedPoints;

  const pathRef = useRef<SVGPathElement>(null);

  const getTotalLength = () => {
    const curveDom = pathRef.current;

    try {
      if (!totalLength || totalLength === 0) {
        return (curveDom && curveDom.getTotalLength && curveDom.getTotalLength()) || 0;
      }
      return totalLength;
    } catch (err) {
      return 0;
    }
  };

  const length = getTotalLength();

  /**
   * This is expensive. But if we don't use it we always stutter on first render.
   * TODO: look into other ways of preventing the extra render
   */
  useLayoutEffect(() => {
    setTotalLength(length);

    return () => {
      setTotalLength(0);
    };
  }, [length]);

  const handleAnimationEnd = () => {
    setIsAnimationFinished(true);

    if (props.onAnimationEnd) {
      props.onAnimationEnd();
    }
  };

  const handleAnimationStart = () => {
    setIsAnimationFinished(false);

    if (props.onAnimationStart) {
      props.onAnimationStart();
    }
  };

  const renderCurve = (needClip: boolean, clipPathId: string) => {
    if (
      isAnimationActive &&
      points &&
      points.length > 0
      // either of these comparisons break animation at the moment. Are these important? Not sure...
      // ((!prevPoints && totalLength > 0) || !isEqual(prevPoints, points))
    ) {
      return (
        <AnimatedCurve
          lineProps={props}
          currentPoints={points}
          prevPoints={prevPoints}
          needClip={needClip}
          clipPathId={clipPathId}
          pathRef={pathRef}
          totalLength={totalLength}
          handleAnimationEnd={handleAnimationEnd}
          handleAnimationStart={handleAnimationStart}
        />
      );
    }

    return (
      <StaticCurve lineProps={props} points={points} needClip={needClip} clipPathId={clipPathId} pathRef={pathRef} />
    );
  };

  const renderErrorBar = (needClip: boolean, clipPathId: string) => {
    if (props.isAnimationActive && !isAnimationFinished) {
      return null;
    }

    const { children } = props;
    const errorBarItems = findAllByType(children, ErrorBar);

    if (!errorBarItems) {
      return null;
    }

    // @ts-expect-error getValueByDataKey does not validate the output type
    const dataPointFormatter: ErrorBarDataPointFormatter = (dataPoint: LinePointItem, formatterDataKey) => {
      return {
        x: dataPoint.x,
        y: dataPoint.y,
        value: dataPoint.value,
        errorVal: getValueByDataKey(dataPoint.payload, formatterDataKey),
      };
    };

    const errorBarProps = {
      clipPath: needClip ? `url(#clipPath-${clipPathId})` : null,
    };

    return (
      <Layer {...errorBarProps}>
        {errorBarItems.map((item: ReactElement<ErrorBarProps>) =>
          React.cloneElement(item, {
            key: `bar-${item.props.dataKey}`,
            data: points,
            // @ts-expect-error scale types are incompatible
            xAxis,
            // @ts-expect-error scale types are incompatible
            yAxis,
            // @ts-expect-error layout type includes 'centric' which ErrorBarProps is not thrilled about
            layout,
            dataPointFormatter,
          }),
        )}
      </Layer>
    );
  };

  const renderDots = (needClip: boolean, clipDot: boolean, clipPathId: string) => {
    if (isAnimationActive && !isAnimationFinished) {
      return null;
    }
    const lineProps = filterProps(props, false);
    const customDotProps = filterProps(dot, true);
    const dots = points.map((entry, i) => {
      const dotProps = {
        key: `dot-${i}`,
        r: 3,
        ...lineProps,
        ...customDotProps,
        value: entry.value,
        dataKey,
        cx: entry.x,
        cy: entry.y,
        index: i,
        payload: entry.payload,
      };

      return renderDotItem(dot, dotProps);
    });
    const dotsProps = {
      clipPath: needClip ? `url(#clipPath-${clipDot ? '' : 'dots-'}${clipPathId})` : null,
    };

    return (
      <Layer className="recharts-line-dots" key="dots" {...dotsProps}>
        {dots}
      </Layer>
    );
  };

  const hasSinglePoint = points.length === 1;
  const layerClass = clsx('recharts-line', className);
  const needClipX = xAxis && xAxis.allowDataOverflow;
  const needClipY = yAxis && yAxis.allowDataOverflow;
  const needClip = needClipX || needClipY;
  const clipPathId = isNil(id) ? id : id;
  const { r = 3, strokeWidth = 2 } = filterProps(dot, false) ?? { r: 3, strokeWidth: 2 };
  const { clipDot = true } = hasClipDot(dot) ? dot : {};
  const dotSize = r * 2 + strokeWidth;

  return (
    <CartesianGraphicalItemContext
      data={props.data}
      xAxisId={xAxisId}
      yAxisId={yAxisId}
      dataKey={dataKey}
      // line doesn't stack
      stackId={undefined}
      hide={hide}
    >
      <Layer className={layerClass}>
        <SetLineLegend {...props} />
        <SetTooltipEntrySettings fn={getTooltipEntrySettings} args={props} />
        {needClipX || needClipY ? (
          <defs>
            <clipPath id={`clipPath-${clipPathId}`}>
              <rect
                x={needClipX ? left : left - width / 2}
                y={needClipY ? top : top - height / 2}
                width={needClipX ? width : width * 2}
                height={needClipY ? height : height * 2}
              />
            </clipPath>
            {!clipDot && (
              <clipPath id={`clipPath-dots-${clipPathId}`}>
                <rect x={left - dotSize / 2} y={top - dotSize / 2} width={width + dotSize} height={height + dotSize} />
              </clipPath>
            )}
          </defs>
        ) : null}
        {!hasSinglePoint && renderCurve(needClip, clipPathId)}
        {renderErrorBar(needClip, clipPathId)}
        {(hasSinglePoint || dot) && renderDots(needClip, clipDot, clipPathId)}
        {(!isAnimationActive || isAnimationFinished) && LabelList.renderCallByParent(props, points)}
      </Layer>
      <ActivePoints activeDot={props.activeDot} points={points} mainColor={props.stroke} itemDataKey={props.dataKey} />
    </CartesianGraphicalItemContext>
  );
};

export class Line extends PureComponent<Props, State> {
  static displayName = 'Line';

  static defaultProps = {
    xAxisId: 0,
    yAxisId: 0,
    connectNulls: false,
    activeDot: true,
    dot: true,
    legendType: 'line',
    stroke: '#3182bd',
    strokeWidth: 1,
    fill: '#fff',
    points: [] as LinePointItem[],
    isAnimationActive: !Global.isSsr,
    animateNewValues: true,
    animationBegin: 0,
    animationDuration: 1500,
    animationEasing: 'ease',
    hide: false,
    label: false,
  };

  id = uniqueId('recharts-line-');

  render() {
    const { hide } = this.props;

    if (hide) {
      return (
        <>
          <SetCartesianGraphicalItem
            data={this.props.data}
            xAxisId={this.props.xAxisId}
            yAxisId={this.props.yAxisId}
            dataKey={this.props.dataKey}
            errorBars={noErrorBars}
            // line doesn't stack
            stackId={undefined}
            hide={this.props.hide}
          />
          <SetLineLegend {...this.props} />
          <SetTooltipEntrySettings fn={getTooltipEntrySettings} args={this.props} />
        </>
      );
    }

    return <LineWrapper {...this.props} id={this.id} />;
  }
}
